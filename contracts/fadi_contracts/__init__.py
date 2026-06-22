"""Fadi↔OpenCut shared contracts. The single source of truth for both the Python
Bridge and the TypeScript front-end (TS generated via codegen.py)."""

from .fadi_edl import FadiEDL
from .song_context import SongContext

__all__ = ["SongContext", "FadiEDL"]
__version__ = "1.0.0"
