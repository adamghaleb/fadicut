"""Project persistence endpoints (batch G, issue #7). All authenticated.

REST surface for the drive-backed `ProjectStore`:

    GET    /projects                 → list projects (lightweight rows, newest first)
    GET    /projects/root            → which root is active right now + drive availability
    POST   /projects/{id}            → save (full doc; optimistic concurrency via expected_rev)
    GET    /projects/{id}            → load (auto-recovers from .bak if main EDL is corrupt)
    GET    /projects/{id}/recovery   → recovery status (did/would it fall back to backup?)
    DELETE /projects/{id}            → delete

Times in the EDL are seconds (the frozen contract); no tick conversion happens here — the
editor's adapter does that at the browser↔EDL edge.

WIRING (the integrator adds one line in bridge/app.py, this batch does not edit it):

    from api.projects import router as projects_router   # in api/__init__.py exports
    app.include_router(projects_router)                  # in create_app()
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from bridge.auth import require_token
from projects import get_project_store
from projects.models import ProjectListing, ProjectDoc, RecoveryInfo, SaveRequest, SaveResult
from projects.store import ProjectStoreError

router = APIRouter(prefix="/projects", tags=["projects"])


def _raise(e: ProjectStoreError) -> None:
    raise HTTPException(status_code=e.status, detail=e.message)


@router.get("", dependencies=[Depends(require_token)])
async def list_projects() -> list[ProjectListing]:
    try:
        return get_project_store().list_projects()
    except ProjectStoreError as e:
        _raise(e)


@router.get("/root", dependencies=[Depends(require_token)])
async def project_root() -> dict:
    """Where projects are being read/written right now. Lets the editor warn the user when
    autosaves are landing on the local fallback because the drive is offline."""
    store = get_project_store()
    root, tag = store.resolve_root()
    return {
        "root": str(root),
        "location": tag,                 # "explicit" | "drive" | "fallback"
        "drive_available": store.drive_available(),
    }


@router.post("/{project_id}", dependencies=[Depends(require_token)], status_code=status.HTTP_200_OK)
async def save_project(project_id: str, body: SaveRequest) -> SaveResult:
    if body.doc.meta.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"path id ({project_id}) != body meta.project_id ({body.doc.meta.project_id})",
        )
    try:
        return get_project_store().save(body.doc, expected_rev=body.expected_rev)
    except ProjectStoreError as e:
        _raise(e)


@router.get("/{project_id}", dependencies=[Depends(require_token)])
async def load_project(project_id: str) -> dict:
    try:
        doc, recovered = get_project_store().load(project_id)
    except ProjectStoreError as e:
        _raise(e)
    # Wrap so the editor knows the load came from a backup and can prompt to re-save.
    return {"doc": doc.model_dump(mode="json"), "recovered_from_backup": recovered}


@router.get("/{project_id}/recovery", dependencies=[Depends(require_token)])
async def project_recovery(project_id: str) -> RecoveryInfo:
    try:
        return get_project_store().recovery_info(project_id)
    except ProjectStoreError as e:
        _raise(e)


@router.delete("/{project_id}", dependencies=[Depends(require_token)])
async def delete_project(project_id: str) -> dict:
    try:
        get_project_store().delete(project_id)
    except ProjectStoreError as e:
        _raise(e)
    return {"deleted": project_id}
