"""Parse ``bridge/asset_roots.toml`` into resolved, online-aware asset roots.

Each root has a ``label``, an expanded filesystem ``path``, a ``kind`` hint (loop /
overlay / clip / footage / mixed …) used as a default tag, and a ``recursive`` flag.

Roots on the Seagate drive go offline when it's unmounted. We never block on them:
``online`` is computed lazily (``path.is_dir()``), so the indexer can skip offline
roots and the editor can degrade gracefully. Resolving the path uses
``expanduser`` but **not** ``resolve(strict=True)`` — an unmounted drive path must
survive as a literal so it indexes the moment the drive comes back.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# asset_roots.toml lives at the repo's bridge/ dir, one level up from this package.
_ROOTS_TOML = Path(__file__).resolve().parent.parent / "asset_roots.toml"

# Marker substrings for paths that live on a removable/network volume. Used only to
# label a root as "removable" in the catalog/API so the UI can explain an offline root.
_REMOVABLE_PREFIXES = ("/Volumes/", "/mnt/", "/media/")


@dataclass(frozen=True)
class AssetRoot:
    label: str
    path: Path
    kind: str
    recursive: bool

    @property
    def online(self) -> bool:
        """True when the root's directory is currently reachable on disk."""
        try:
            return self.path.is_dir()
        except OSError:
            return False

    @property
    def removable(self) -> bool:
        s = str(self.path)
        return any(s.startswith(p) for p in _REMOVABLE_PREFIXES)

    def public(self) -> dict:
        return {
            "label": self.label,
            "path": str(self.path),
            "kind": self.kind,
            "recursive": self.recursive,
            "online": self.online,
            "removable": self.removable,
        }


def _coerce_roots(doc: dict) -> list[AssetRoot]:
    out: list[AssetRoot] = []
    for entry in doc.get("root", []):
        raw = entry.get("path")
        if not raw:
            continue
        path = Path(str(raw)).expanduser()
        out.append(
            AssetRoot(
                label=str(entry.get("label") or path.name),
                path=path,
                kind=str(entry.get("kind") or "mixed"),
                recursive=bool(entry.get("recursive", True)),
            )
        )
    return out


def load_roots(toml_path: Path | None = None) -> list[AssetRoot]:
    """Parse the roots TOML. Returns ``[]`` if the file is missing/empty."""
    p = toml_path or _ROOTS_TOML
    try:
        with open(p, "rb") as f:
            doc = tomllib.load(f)
    except FileNotFoundError:
        return []
    except tomllib.TOMLDecodeError:
        return []
    return _coerce_roots(doc)


@lru_cache(maxsize=1)
def get_roots() -> tuple[AssetRoot, ...]:
    """Cached roots (parsed once). Call ``get_roots.cache_clear()`` to reload."""
    return tuple(load_roots())


def online_roots() -> list[AssetRoot]:
    return [r for r in get_roots() if r.online]
