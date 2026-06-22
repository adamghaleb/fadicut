"""Drive-backed project persistence (batch G, issue #7).

The editor's source of truth for a project is a `FadiEDL` (the frozen contract) plus a
small `meta` blob (title, song binding, thumbnails, timestamps). This package stores each
project as a directory under a configurable `projects/` root on the Seagate drive, with a
graceful fallback to `~/Documents/fadicut-projects` when the drive is offline.

Layout on disk (one dir per project):

    <projects-root>/<project_id>/
        edl.json        # the FadiEDL document (contract-shaped, times in seconds)
        meta.json       # ProjectMeta: title, song_id, updated_at, rev, thumbnail_ref…
        edl.json.bak    # previous good EDL (single-deep backup for crash recovery)

Writes are atomic (temp file + os.replace) and bump a monotonic `rev` so the editor can
detect conflicts / drive-clobber across sessions. Reads tolerate a half-written `edl.json`
by falling back to `edl.json.bak`.

Exposes:
    * `ProjectStore`        — the storage engine (drive-aware, atomic, path-safe)
    * `get_project_store()` — cached singleton honoring env config
    * `projects_router`     — the FastAPI router (see api/projects.py); import + include it
                              in bridge/app.py:  `app.include_router(projects_router)`

Nothing here is wired into the core app automatically — the integrator adds the one-line
`include_router` so this batch never edits the shared app/registry files.
"""

from .store import ProjectStore, ProjectStoreError, get_project_store
from .models import ProjectMeta, ProjectDoc, ProjectListing

__all__ = [
    "ProjectStore",
    "ProjectStoreError",
    "get_project_store",
    "ProjectMeta",
    "ProjectDoc",
    "ProjectListing",
]
