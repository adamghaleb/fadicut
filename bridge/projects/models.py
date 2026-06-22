"""Pydantic models for drive-backed project persistence.

These wrap (never replace) the frozen contract. The on-disk `edl.json` is a verbatim
`FadiEDL`; `meta.json` is editor-side bookkeeping that the contract intentionally does not
carry (titles, timestamps, revision counter, thumbnail reference, song display name).
"""

from __future__ import annotations

import time
from typing import Any, Optional

from pydantic import BaseModel, Field

# The frozen contract. Imported, never modified.
from fadi_contracts.fadi_edl import FadiEDL


def _now() -> float:
    return time.time()


class ProjectMeta(BaseModel):
    """Per-project bookkeeping stored alongside the EDL. Not part of the frozen contract."""

    project_id: str
    title: str = "untitled"
    song_id: Optional[str] = None
    song_name: Optional[str] = None

    # Monotonic revision — bumped on every successful write. The editor sends the rev it
    # last loaded; a mismatch on save means another session/machine touched the file
    # (the multi-session drive-clobber failure mode), so the Bridge returns 409.
    rev: int = 0

    created_at: float = Field(default_factory=_now)
    updated_at: float = Field(default_factory=_now)

    # Optional reference to a thumbnail/poster (a path under a media root, served via /media).
    thumbnail_ref: Optional[str] = None

    # Where the project currently lives — "drive" or "fallback". Informational; lets the
    # editor warn the user that autosaves are going to the local fallback, not the drive.
    storage_location: str = "drive"

    # Free-form editor extras (zoom, selection, panel layout) the contract doesn't model.
    editor_state: dict[str, Any] = Field(default_factory=dict)


class ProjectDoc(BaseModel):
    """The full project payload exchanged over the wire: contract EDL + meta."""

    meta: ProjectMeta
    edl: FadiEDL


class ProjectListing(BaseModel):
    """Lightweight row for the project picker — no EDL body."""

    project_id: str
    title: str
    song_id: Optional[str] = None
    song_name: Optional[str] = None
    rev: int = 0
    updated_at: float = 0.0
    thumbnail_ref: Optional[str] = None
    storage_location: str = "drive"


class SaveRequest(BaseModel):
    """Body of POST /projects/{id}. The full doc plus optional optimistic-concurrency guard."""

    doc: ProjectDoc
    # If provided, the save fails with 409 unless it matches the stored rev (the rev the
    # client loaded). Omit (autosave bootstrap / force) to skip the check.
    expected_rev: Optional[int] = None


class SaveResult(BaseModel):
    project_id: str
    rev: int
    updated_at: float
    storage_location: str


class RecoveryInfo(BaseModel):
    """Returned by /projects/{id}/recovery — tells the editor whether the main EDL is
    intact or whether it had to fall back to the .bak, so it can surface a recovery prompt."""

    project_id: str
    recovered_from_backup: bool
    edl_ok: bool
    backup_present: bool
    rev: int
    updated_at: float
