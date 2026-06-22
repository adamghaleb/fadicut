# Project persistence — Bridge integration (batch G / issue #7)

This package (`bridge/projects/`) + its router (`bridge/api/projects.py`) add drive-backed
project read/write to the Fadi Bridge. It does **not** edit any shared/registry file. The
integrator wires it with the small edits below.

## 1. Export the router (`bridge/api/__init__.py`)

Add alongside the existing exports:

```python
from .projects import router as projects_router
# extend __all__:
#   __all__ = ["health_router", "jobs_router", "media_router", "projects_router"]
```

## 2. Include it (`bridge/bridge/app.py`, inside `create_app()`)

```python
from api import health_router, jobs_router, media_router, projects_router
...
app.include_router(projects_router)
```

## 3. Package discovery (`bridge/pyproject.toml`)

`[tool.setuptools.packages.find].include` must list `projects*` so `pip install -e .`
ships it (runtime-from-cwd already works without this):

```toml
include = ["bridge*", "api*", "jobs*", "assets*", "render*", "projects*"]
```

## Config (env)

| Env var              | Default                           | Meaning                                                       |
| -------------------- | --------------------------------- | ------------------------------------------------------------- |
| `FADI_PROJECTS_ROOT` | _(unset)_                         | Explicit projects root — overrides drive/fallback.            |
| `FADI_DRIVE_ROOT`    | `/Volumes/Seagate Portable Drive` | Drive mount point. Projects go in `<drive>/FADICUT-PROJECTS`. |
| _(fallback)_         | `~/Documents/fadicut-projects`    | Used when the drive is unmounted/unwritable.                  |

Root selection is re-evaluated on every request, so a drive that mounts/unmounts mid-session
is picked up live; each project's `storage_location` records where the write landed.

## Endpoints (all require the bearer token)

```
GET    /projects                 list (newest first, no EDL body)
GET    /projects/root            active root + drive availability
POST   /projects/{id}            save  (body: { doc, expected_rev? }) — 409 on rev conflict
GET    /projects/{id}            load  ({ doc, recovered_from_backup })
GET    /projects/{id}/recovery   recovery status
DELETE /projects/{id}            delete
```

## On-disk layout

```
<root>/<project_id>/
    edl.json        FadiEDL (frozen contract; times in seconds)
    meta.json       ProjectMeta (title, song, rev, timestamps, thumbnail_ref)
    edl.json.bak    previous good EDL — single-deep crash-recovery snapshot
```

Writes are atomic (`tempfile` + `os.replace` + `fsync`); `meta.json` is written after
`edl.json` so a crash between them leaves a consistent (older) rev rather than a dangling one.
A monotonic `rev` gives optimistic concurrency (the multi-session drive-clobber guard).
`project_id` is slug-validated and every resolved path is asserted inside the root.
