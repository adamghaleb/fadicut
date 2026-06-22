"""SQLite asset catalog + incremental indexer.

The catalog is the searchable index of every Fadi-style asset across the roots in
``asset_roots.toml``. One row per file path, keyed for change-detection by
(size, mtime) and content-identified by a partial content hash.

Schema (table ``assets``)::

    path        TEXT PRIMARY KEY   absolute filesystem path
    root_label  TEXT               which asset_roots.toml root it came from
    content_hash TEXT              blake2b over head+tail+size (cheap, collision-safe enough)
    kind        TEXT               video | image | audio | unknown
    codec       TEXT
    duration    REAL               seconds (NULL for stills)
    width       INTEGER
    height      INTEGER
    fps         REAL
    has_alpha   INTEGER            0/1 — ProRes 4444 / PNG-alpha loops + overlays
    size        INTEGER            bytes
    mtime       REAL               file mtime (epoch)
    kind_hint   TEXT               root's `kind` (loop/overlay/clip/footage/mixed)
    tags        TEXT               JSON array of user/auto tags
    name        TEXT               basename
    indexed_at  REAL               epoch when last (re)indexed
    proxy_path  TEXT               path to generated proxy (NULL until built)

Incrementality: an existing row whose (size, mtime) is unchanged is skipped without
re-probing or re-hashing. ``index_roots`` only walks **online** roots, so an
unmounted Seagate drive leaves its rows intact (marked stale via ``missing``) and is
re-synced when it returns. Concurrency-safe via WAL + a per-connection cursor; all
write paths go through short transactions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

from .probe import is_media_file, probe
from .roots import AssetRoot, get_roots, online_roots

log = logging.getLogger("fadi.bridge.assets")

# Default catalog location: alongside the bridge package (gitignored data dir).
_DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "asset_catalog.db"

_HASH_HEAD_TAIL = 256 * 1024  # hash first+last 256 KiB + size — fast on big ProRes files

_SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    path         TEXT PRIMARY KEY,
    root_label   TEXT,
    content_hash TEXT,
    kind         TEXT,
    codec        TEXT,
    duration     REAL,
    width        INTEGER,
    height       INTEGER,
    fps          REAL,
    has_alpha    INTEGER DEFAULT 0,
    size         INTEGER,
    mtime        REAL,
    kind_hint    TEXT,
    tags         TEXT DEFAULT '[]',
    name         TEXT,
    indexed_at   REAL,
    proxy_path   TEXT,
    missing      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
CREATE INDEX IF NOT EXISTS idx_assets_hint ON assets(kind_hint);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
"""


def content_hash(path: Path, size: int) -> str:
    """Cheap, stable content id: blake2b over head+tail bytes + size.

    Avoids reading multi-GB ProRes clips in full while still distinguishing edits.
    """
    h = hashlib.blake2b(digest_size=16)
    h.update(str(size).encode())
    try:
        with open(path, "rb") as f:
            head = f.read(_HASH_HEAD_TAIL)
            h.update(head)
            if size > _HASH_HEAD_TAIL * 2:
                f.seek(-_HASH_HEAD_TAIL, 2)
                h.update(f.read(_HASH_HEAD_TAIL))
    except OSError:
        return h.hexdigest()  # size-only hash on read failure
    return h.hexdigest()


@dataclass
class IndexStats:
    scanned: int = 0
    added: int = 0
    updated: int = 0
    skipped: int = 0
    removed: int = 0
    errors: int = 0
    roots_online: int = 0
    roots_offline: int = 0
    elapsed: float = 0.0

    def public(self) -> dict:
        return self.__dict__.copy()


class AssetCatalog:
    """Thread-safe wrapper over the SQLite catalog DB."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or _DEFAULT_DB
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # ── lifecycle ────────────────────────────────────────────────────────────
    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ── reads ────────────────────────────────────────────────────────────────
    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        d["has_alpha"] = bool(d.get("has_alpha"))
        d["missing"] = bool(d.get("missing"))
        try:
            d["tags"] = json.loads(d.get("tags") or "[]")
        except (TypeError, json.JSONDecodeError):
            d["tags"] = []
        return d

    def get(self, path: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM assets WHERE path = ?", (path,)).fetchone()
        return self._row_to_dict(row) if row else None

    def count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]

    def all_tags(self) -> list[dict]:
        """Distinct tags across the catalog with usage counts."""
        with self._lock:
            rows = self._conn.execute("SELECT tags FROM assets").fetchall()
        counts: dict[str, int] = {}
        for r in rows:
            try:
                for t in json.loads(r["tags"] or "[]"):
                    counts[t] = counts.get(t, 0) + 1
            except (TypeError, json.JSONDecodeError):
                continue
        return sorted(
            ({"tag": k, "count": v} for k, v in counts.items()),
            key=lambda x: (-x["count"], x["tag"]),
        )

    def search(
        self,
        *,
        q: str | None = None,
        kind: str | None = None,
        kind_hint: str | None = None,
        tags: Iterable[str] | None = None,
        has_alpha: bool | None = None,
        root_label: str | None = None,
        include_missing: bool = False,
        sort: str = "name",
        order: str = "asc",
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Filtered search. Returns (rows, total_matching_count)."""
        where: list[str] = []
        params: list = []
        if not include_missing:
            where.append("missing = 0")
        if q:
            where.append("(name LIKE ? OR path LIKE ?)")
            like = f"%{q}%"
            params += [like, like]
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if kind_hint:
            where.append("kind_hint = ?")
            params.append(kind_hint)
        if has_alpha is not None:
            where.append("has_alpha = ?")
            params.append(1 if has_alpha else 0)
        if root_label:
            where.append("root_label = ?")
            params.append(root_label)
        # tags filter: AND semantics, matched on the JSON text (good enough at this scale).
        if tags:
            for t in tags:
                where.append("tags LIKE ?")
                params.append(f'%"{t}"%')

        sort_col = sort if sort in {"name", "kind", "duration", "size", "indexed_at"} else "name"
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""

        with self._lock:
            total = self._conn.execute(
                f"SELECT COUNT(*) FROM assets{where_sql}", params
            ).fetchone()[0]
            rows = self._conn.execute(
                f"SELECT * FROM assets{where_sql} "
                f"ORDER BY {sort_col} {sort_dir} LIMIT ? OFFSET ?",
                [*params, max(0, min(limit, 1000)), max(0, offset)],
            ).fetchall()
        return [self._row_to_dict(r) for r in rows], total

    # ── tag mutation ───────────────────────────────────────────────────────--
    def set_tags(self, path: str, tags: list[str]) -> dict | None:
        clean = sorted({str(t).strip() for t in tags if str(t).strip()})
        with self._lock:
            cur = self._conn.execute(
                "UPDATE assets SET tags = ? WHERE path = ?", (json.dumps(clean), path)
            )
            self._conn.commit()
            if cur.rowcount == 0:
                return None
        return self.get(path)

    def add_tags(self, path: str, tags: list[str]) -> dict | None:
        existing = self.get(path)
        if not existing:
            return None
        merged = sorted(set(existing["tags"]) | {str(t).strip() for t in tags if str(t).strip()})
        return self.set_tags(path, merged)

    def remove_tags(self, path: str, tags: list[str]) -> dict | None:
        existing = self.get(path)
        if not existing:
            return None
        drop = {str(t).strip() for t in tags}
        return self.set_tags(path, [t for t in existing["tags"] if t not in drop])

    def set_proxy(self, path: str, proxy_path: str | None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE assets SET proxy_path = ? WHERE path = ?", (proxy_path, path)
            )
            self._conn.commit()

    # ── indexing ───────────────────────────────────────────────────────────--
    def _walk(self, root: AssetRoot) -> Iterator[Path]:
        base = root.path
        if root.recursive:
            it = base.rglob("*")
        else:
            it = base.glob("*")
        for p in it:
            try:
                if p.is_file() and not p.name.startswith(".") and is_media_file(p):
                    yield p
            except OSError:
                continue

    def upsert_file(self, path: Path, root: AssetRoot, *, force: bool = False) -> str:
        """Index/refresh one file. Returns 'added' | 'updated' | 'skipped' | 'error'.

        Skips re-probing when (size, mtime) match the stored row (unless force).
        """
        try:
            st = path.stat()
        except OSError:
            return "error"
        size, mtime = st.st_size, st.st_mtime
        spath = str(path)

        with self._lock:
            row = self._conn.execute(
                "SELECT size, mtime FROM assets WHERE path = ?", (spath,)
            ).fetchone()

        if row and not force and row["size"] == size and abs((row["mtime"] or 0) - mtime) < 1e-6:
            # Unchanged — just clear any stale `missing` flag.
            with self._lock:
                self._conn.execute("UPDATE assets SET missing = 0 WHERE path = ?", (spath,))
                self._conn.commit()
            return "skipped"

        pr = probe(path)
        chash = content_hash(path, size)
        now = time.time()
        is_new = row is None

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO assets (path, root_label, content_hash, kind, codec, duration,
                    width, height, fps, has_alpha, size, mtime, kind_hint, name,
                    indexed_at, missing, tags)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,
                    COALESCE((SELECT tags FROM assets WHERE path = ?), '[]'))
                ON CONFLICT(path) DO UPDATE SET
                    root_label=excluded.root_label, content_hash=excluded.content_hash,
                    kind=excluded.kind, codec=excluded.codec, duration=excluded.duration,
                    width=excluded.width, height=excluded.height, fps=excluded.fps,
                    has_alpha=excluded.has_alpha, size=excluded.size, mtime=excluded.mtime,
                    kind_hint=excluded.kind_hint, name=excluded.name,
                    indexed_at=excluded.indexed_at, missing=0
                """,
                (
                    spath, root.label, chash, pr.kind, pr.codec, pr.duration,
                    pr.width, pr.height, pr.fps, 1 if pr.has_alpha else 0,
                    size, mtime, root.kind, path.name, now, spath,
                ),
            )
            self._conn.commit()
        return "added" if is_new else "updated"

    def index_roots(self, *, force: bool = False, roots: list[AssetRoot] | None = None) -> IndexStats:
        """Walk all online roots and sync the catalog. Marks vanished files ``missing``."""
        t0 = time.time()
        stats = IndexStats()
        all_roots = list(roots) if roots is not None else list(get_roots())
        live = [r for r in all_roots if r.online]
        stats.roots_online = len(live)
        stats.roots_offline = len(all_roots) - len(live)

        seen_per_online_root: dict[str, set[str]] = {}
        for root in live:
            seen = seen_per_online_root.setdefault(root.label, set())
            for fp in self._walk(root):
                stats.scanned += 1
                seen.add(str(fp))
                result = self.upsert_file(fp, root, force=force)
                if result == "added":
                    stats.added += 1
                elif result == "updated":
                    stats.updated += 1
                elif result == "skipped":
                    stats.skipped += 1
                else:
                    stats.errors += 1

        # Mark files that belong to an online root but were not seen as missing.
        online_labels = {r.label for r in live}
        for label in online_labels:
            seen = seen_per_online_root.get(label, set())
            with self._lock:
                rows = self._conn.execute(
                    "SELECT path FROM assets WHERE root_label = ? AND missing = 0", (label,)
                ).fetchall()
                gone = [r["path"] for r in rows if r["path"] not in seen]
                for g in gone:
                    self._conn.execute("UPDATE assets SET missing = 1 WHERE path = ?", (g,))
                    stats.removed += 1
                if gone:
                    self._conn.commit()

        stats.elapsed = time.time() - t0
        log.info(
            "asset index: scanned=%d added=%d updated=%d skipped=%d missing=%d errs=%d "
            "online=%d offline=%d in %.2fs",
            stats.scanned, stats.added, stats.updated, stats.skipped, stats.removed,
            stats.errors, stats.roots_online, stats.roots_offline, stats.elapsed,
        )
        return stats

    def root_status(self) -> list[dict]:
        """Per-root summary: online flag + indexed count (for the editor's offline UI)."""
        out = []
        for r in get_roots():
            with self._lock:
                n = self._conn.execute(
                    "SELECT COUNT(*) FROM assets WHERE root_label = ? AND missing = 0", (r.label,)
                ).fetchone()[0]
            d = r.public()
            d["indexed_count"] = n
            out.append(d)
        return out


# ── module singleton ─────────────────────────────────────────────────────────
_catalog: AssetCatalog | None = None
_catalog_lock = threading.Lock()


def get_catalog() -> AssetCatalog:
    global _catalog
    with _catalog_lock:
        if _catalog is None:
            _catalog = AssetCatalog()
    return _catalog
