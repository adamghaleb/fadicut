"""ProjectStore — drive-aware, atomic, path-safe project persistence.

Root resolution (in order):
    1. env `FADI_PROJECTS_ROOT` if set                       (explicit override)
    2. `<drive>/FADICUT-PROJECTS` if the drive is mounted     (preferred — Seagate)
    3. `~/Documents/fadicut-projects`                          (fallback when drive offline)

The drive path itself is configurable via env `FADI_DRIVE_ROOT`
(default "/Volumes/Seagate Portable Drive"). Resolution is re-evaluated on every call so a
drive that mounts/unmounts mid-session is picked up without a restart; `storage_location`
on each project records where the write actually landed so the editor can warn the user.

Safety:
    * project_id is validated against a strict slug pattern — no path separators, no `..`,
      no leading dots — so it can never escape the projects root.
    * every resolved project dir is asserted to live inside the resolved root (realpath).

Durability:
    * writes go to a temp file in the same dir then `os.replace` (atomic on POSIX).
    * the previous `edl.json` is copied to `edl.json.bak` before overwrite, giving a
      single-deep crash-recovery snapshot.
    * a stored `rev` enables optimistic concurrency (detects multi-session clobber).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from functools import lru_cache
from pathlib import Path
from typing import Optional

from .models import (
    ProjectDoc,
    ProjectListing,
    ProjectMeta,
    RecoveryInfo,
    SaveResult,
)

# strict project id: lowercase/upper alnum, dash, underscore — 1..128 chars. No dots/slashes.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

_DEFAULT_DRIVE_ROOT = "/Volumes/Seagate Portable Drive"
_DRIVE_PROJECTS_DIRNAME = "FADICUT-PROJECTS"
_FALLBACK_ROOT = Path.home() / "Documents" / "fadicut-projects"

EDL_FILE = "edl.json"
META_FILE = "meta.json"
EDL_BAK_FILE = "edl.json.bak"


class ProjectStoreError(Exception):
    """Base error. Carries an HTTP-ish `status` so the router can map cleanly."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


class ProjectNotFound(ProjectStoreError):
    def __init__(self, project_id: str):
        super().__init__(f"no such project: {project_id}", status=404)


class ProjectConflict(ProjectStoreError):
    def __init__(self, message: str):
        super().__init__(message, status=409)


def _validate_id(project_id: str) -> str:
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ProjectStoreError(
            f"invalid project_id (must match {_ID_RE.pattern!r}): {project_id!r}", status=400
        )
    return project_id


class ProjectStore:
    """Filesystem-backed project store. Stateless beyond its configured paths; safe to share."""

    def __init__(
        self,
        *,
        explicit_root: Optional[Path] = None,
        drive_root: Optional[Path] = None,
        fallback_root: Optional[Path] = None,
    ):
        self._explicit_root = explicit_root
        self._drive_root = drive_root or Path(_DEFAULT_DRIVE_ROOT)
        self._fallback_root = fallback_root or _FALLBACK_ROOT

    # ── root resolution ───────────────────────────────────────────────────────

    def drive_available(self) -> bool:
        """True when the drive root is a mounted, writable directory.

        Checks the mount point itself (not the FADICUT-PROJECTS subdir, which may not
        exist yet — it is created on demand by `resolve_root`).
        """
        try:
            return self._drive_root.is_dir() and os.access(self._drive_root, os.W_OK)
        except OSError:
            return False

    @property
    def drive_projects_dir(self) -> Path:
        """The intended on-drive projects root (whether or not it currently exists)."""
        return self._drive_root / _DRIVE_PROJECTS_DIRNAME

    def resolve_root(self) -> tuple[Path, str]:
        """Return (root_path, location_tag). location_tag ∈ {'explicit','drive','fallback'}.

        Re-evaluated on every call so mount/unmount is picked up live. Ensures the chosen
        root exists (mkdir -p) before returning.

        Drive preference is *effective*: when the Seagate is mounted we actually create and
        use `<drive>/FADICUT-PROJECTS`. We only fall back to `~/Documents/fadicut-projects`
        when the drive is genuinely absent, or when creating/writing the on-drive projects
        dir fails (read-only mount, full disk, permissions) — never silently while a healthy
        drive is present.
        """
        if self._explicit_root is not None:
            root = self._explicit_root
            root.mkdir(parents=True, exist_ok=True)
            return root.resolve(), "explicit"

        if self.drive_available():
            drive_root = self.drive_projects_dir
            try:
                drive_root.mkdir(parents=True, exist_ok=True)
                # Confirm it is actually a usable, writable directory before committing to it.
                if drive_root.is_dir() and os.access(drive_root, os.W_OK):
                    return drive_root.resolve(), "drive"
            except OSError:
                pass  # drive present but unwritable — fall through to the local fallback

        root = self._fallback_root
        root.mkdir(parents=True, exist_ok=True)
        return root.resolve(), "fallback"

    def _project_dir(self, project_id: str, *, create: bool = False) -> tuple[Path, str]:
        _validate_id(project_id)
        root, tag = self.resolve_root()
        d = (root / project_id).resolve()
        # Defense in depth: the resolved dir must stay inside the root.
        try:
            d.relative_to(root)
        except ValueError:
            raise ProjectStoreError("resolved project path escaped the projects root", status=403)
        if create:
            d.mkdir(parents=True, exist_ok=True)
        return d, tag

    # ── primitives ────────────────────────────────────────────────────────────

    @staticmethod
    def _atomic_write_json(path: Path, obj: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)  # atomic on the same filesystem
        finally:
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    @staticmethod
    def _read_json(path: Path) -> Optional[dict]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

    # ── public API ──────────────────────────────────────────────────────────────

    def list_projects(self) -> list[ProjectListing]:
        root, tag = self.resolve_root()
        out: list[ProjectListing] = []
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            meta_raw = self._read_json(child / META_FILE)
            if not meta_raw:
                continue
            try:
                meta = ProjectMeta.model_validate(meta_raw)
            except Exception:
                continue
            out.append(
                ProjectListing(
                    project_id=meta.project_id,
                    title=meta.title,
                    song_id=meta.song_id,
                    song_name=meta.song_name,
                    rev=meta.rev,
                    updated_at=meta.updated_at,
                    thumbnail_ref=meta.thumbnail_ref,
                    storage_location=tag,
                )
            )
        out.sort(key=lambda r: r.updated_at, reverse=True)
        return out

    def exists(self, project_id: str) -> bool:
        d, _ = self._project_dir(project_id)
        return (d / META_FILE).is_file()

    def load(self, project_id: str) -> tuple[ProjectDoc, bool]:
        """Load a project. Returns (doc, recovered_from_backup).

        If `edl.json` is missing or corrupt, falls back to `edl.json.bak`.
        """
        d, tag = self._project_dir(project_id)
        if not (d / META_FILE).is_file():
            raise ProjectNotFound(project_id)

        meta_raw = self._read_json(d / META_FILE)
        if meta_raw is None:
            raise ProjectStoreError(f"project {project_id} meta is unreadable/corrupt", status=500)
        meta = ProjectMeta.model_validate(meta_raw)
        meta.storage_location = tag

        recovered = False
        edl_raw = self._read_json(d / EDL_FILE)
        if edl_raw is None:
            edl_raw = self._read_json(d / EDL_BAK_FILE)
            recovered = edl_raw is not None
        if edl_raw is None:
            raise ProjectStoreError(
                f"project {project_id} EDL is missing and no usable backup exists", status=500
            )

        from fadi_contracts.fadi_edl import FadiEDL

        edl = FadiEDL.model_validate(edl_raw)
        return ProjectDoc(meta=meta, edl=edl), recovered

    def save(self, doc: ProjectDoc, *, expected_rev: Optional[int] = None) -> SaveResult:
        """Persist a project. Optimistic concurrency via `expected_rev`.

        On first save (no existing dir) `expected_rev` is ignored. On a subsequent save,
        if `expected_rev` is given and does not match the stored rev, raises ProjectConflict
        (the multi-session drive-clobber guard). The stored rev is bumped on success.
        """
        project_id = _validate_id(doc.meta.project_id)
        # Keep the EDL's project_id and the meta's in lockstep — they MUST agree.
        if doc.edl.project_id != project_id:
            raise ProjectStoreError(
                f"meta.project_id ({project_id}) != edl.project_id ({doc.edl.project_id})",
                status=400,
            )

        d, tag = self._project_dir(project_id, create=True)
        existing_meta = self._read_json(d / META_FILE)
        stored_rev = int(existing_meta.get("rev", 0)) if existing_meta else None

        if stored_rev is not None and expected_rev is not None and expected_rev != stored_rev:
            raise ProjectConflict(
                f"rev conflict: client had {expected_rev}, store has {stored_rev} "
                f"(another session edited this project)"
            )

        now = time.time()
        new_rev = (stored_rev or 0) + 1

        meta = doc.meta.model_copy(
            update={
                "rev": new_rev,
                "updated_at": now,
                "storage_location": tag,
                "created_at": (
                    float(existing_meta.get("created_at", now)) if existing_meta else doc.meta.created_at
                ),
            }
        )

        # Backup the current good EDL before overwriting (single-deep recovery snapshot).
        edl_path = d / EDL_FILE
        if edl_path.is_file():
            try:
                shutil.copy2(edl_path, d / EDL_BAK_FILE)
            except OSError:
                pass  # backup is best-effort; never block a save on it

        # Write EDL first, then meta — so a crash between the two leaves meta pointing at
        # the OLD rev (consistent) rather than meta claiming a rev the EDL doesn't have.
        self._atomic_write_json(edl_path, doc.edl.model_dump(mode="json"))
        self._atomic_write_json(d / META_FILE, meta.model_dump(mode="json"))

        return SaveResult(
            project_id=project_id, rev=new_rev, updated_at=now, storage_location=tag
        )

    def delete(self, project_id: str) -> None:
        d, _ = self._project_dir(project_id)
        if not d.is_dir():
            raise ProjectNotFound(project_id)
        shutil.rmtree(d)

    def recovery_info(self, project_id: str) -> RecoveryInfo:
        d, _ = self._project_dir(project_id)
        if not (d / META_FILE).is_file():
            raise ProjectNotFound(project_id)
        meta_raw = self._read_json(d / META_FILE) or {}
        edl_raw = self._read_json(d / EDL_FILE)
        backup_present = (d / EDL_BAK_FILE).is_file()
        edl_ok = edl_raw is not None
        return RecoveryInfo(
            project_id=project_id,
            recovered_from_backup=not edl_ok and backup_present,
            edl_ok=edl_ok,
            backup_present=backup_present,
            rev=int(meta_raw.get("rev", 0)),
            updated_at=float(meta_raw.get("updated_at", 0.0)),
        )


@lru_cache(maxsize=1)
def get_project_store() -> ProjectStore:
    """Cached singleton honoring env config:

    * FADI_PROJECTS_ROOT — explicit projects root (overrides drive/fallback logic)
    * FADI_DRIVE_ROOT    — the drive mount point (default "/Volumes/Seagate Portable Drive")
    """
    explicit = os.environ.get("FADI_PROJECTS_ROOT", "").strip()
    drive = os.environ.get("FADI_DRIVE_ROOT", "").strip()
    return ProjectStore(
        explicit_root=Path(explicit).expanduser() if explicit else None,
        drive_root=Path(drive).expanduser() if drive else None,
    )
