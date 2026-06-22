"""
FadiEDL — the Edit Decision List that crosses the browser↔native boundary.

OpenCut edits in the browser; the *final* render happens natively in the Fadi Bridge
(full ffmpeg, RIFE on the M2 GPU, the PIL/HarfBuzz lyric engine, the Fadi grade). The
timeline serializes a FadiEDL; the Bridge's render orchestrator consumes it and calls
the right tools in the right order.

Design rule: FadiEDL MIRRORS OpenCut's own scene model (apps/web/src/timeline/types.ts)
so the browser→EDL adapter is a 1:1 mapping, not a translation. Differences from OpenCut:
  • all times are **seconds (float)**, not MediaTime ticks (convert at the edge)
  • tracks are a flat ordered list with a `role` (main/overlay/audio), preserving
    OpenCut's SceneTracks grouping without its nesting
  • effects are Fadi-namespaced discriminated unions carrying the params each native
    tool needs to bake

Effects follow the "preview vs authoritative" convention: the browser renders an
approximate preview from the same params; `engine` names the native baker the Bridge
must call for the real thing.

Source of truth: this Pydantic model. Bump SCHEMA_VERSION on any breaking change.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.1.0"


# ───────────────────────── effects (discriminated by `type`) ─────────────────────────

class BezierCurve(BaseModel):
    """Cubic-bezier control points. Default = Adam's signature easing curve."""

    p: tuple[float, float, float, float] = (0.765, 0.0, 0.106, 1.0)


class MotionBlur(BaseModel):
    shutter_deg: float = 360.0
    samples: int = 36
    intensity: float = 1.75


class GradeEffect(BaseModel):
    type: Literal["grade"] = "grade"
    engine: Literal["fadi_grade"] = "fadi_grade"
    # HLS hue+sat substitution preserving L from a B&W base (Photoshop "Color" blend).
    mode: Literal["hls_substitution", "rainbow", "hue_shift", "outline"] = "hls_substitution"
    fadi_color: Optional[str] = Field(None, description="Hex of the Fadi color to substitute, when single-color.")
    preset: Optional[str] = None
    params: dict = Field(default_factory=dict, description="Free-form knobs the grade script understands.")


class RampEffect(BaseModel):
    type: Literal["ramp"] = "ramp"
    engine: Literal["speedramp"] = "speedramp"
    mode: Literal["whoosh", "up", "down", "transit"] = "whoosh"
    curve: BezierCurve = Field(default_factory=BezierCurve)
    target_rate: Optional[float] = Field(None, description="Peak speed multiplier at terminal velocity.")
    use_rife: bool = True
    motion_blur: MotionBlur = Field(default_factory=MotionBlur)


class LyricEffect(BaseModel):
    type: Literal["lyric"] = "lyric"
    engine: Literal["meandu"] = "meandu"
    # Which slice of the bound SongContext's lyrics this element renders.
    line_range: Optional[tuple[int, int]] = Field(None, description="[firstLineIdx, lastLineIdx] inclusive.")
    fill_mode: Literal["white", "black", "strobe", "tri_zone"] = "tri_zone"
    font: Optional[str] = None
    weight: Optional[str] = None
    tracking: float = -0.02
    stroke_px: float = 6.0
    strobe_palette: list[str] = Field(default_factory=list)
    params: dict = Field(default_factory=dict)


class StrobeEffect(BaseModel):
    type: Literal["strobe"] = "strobe"
    engine: Literal["fadi_strobe"] = "fadi_strobe"
    palette: list[str] = Field(default_factory=list)
    every_n_frames: int = 3
    luminance_preserve: bool = True


class OverlayEffect(BaseModel):
    type: Literal["overlay"] = "overlay"
    engine: Literal["fadishoot_overlays"] = "fadishoot_overlays"
    asset_id: Optional[str] = None
    category: Optional[str] = Field(None, description='e.g. "color_bars", "checker", "333_logo".')
    beat_sync: bool = True
    coverage: Literal["full", "partial"] = "partial"


class MorphEffect(BaseModel):
    type: Literal["morph"] = "morph"
    engine: Literal["morphloop"] = "morphloop"
    target_media_ids: list[str] = Field(default_factory=list, description="Images to morph A→B→C→D.")
    beat_cut: bool = True


class MicrographicsEffect(BaseModel):
    """Fadi micrographic overlay treatment (the FadiFiles 'micrographics on every image'
    rule): readouts, hairline grids, registration marks, micro-labels composited over a
    clip. Baked natively from the fadifiles micrographics engine."""

    type: Literal["micrographics"] = "micrographics"
    engine: Literal["fadi_micrographics"] = "fadi_micrographics"
    density: Literal["sparse", "medium", "dense"] = "medium"
    palette: list[str] = Field(default_factory=list, description="Fadi colors for the micro elements.")
    seed: Optional[int] = Field(None, description="Deterministic layout seed.")
    params: dict = Field(default_factory=dict)


class BlobTrackEffect(BaseModel):
    """Square micrographic blob that tracks the subject across the clip (the FadiFiles
    blob-tracking treatment). Baked natively from the music-video blob engine."""

    type: Literal["blob_track"] = "blob_track"
    engine: Literal["fadi_blob_track"] = "fadi_blob_track"
    shape: Literal["square", "rounded", "circle"] = "square"
    color: Optional[str] = Field(None, description="Hex of the blob fill / outline.")
    follow: Literal["subject", "center", "motion"] = "subject"
    beat_react: bool = True
    params: dict = Field(default_factory=dict)


class GenericEffect(BaseModel):
    """Pass-through for OpenCut's own native effects we don't special-case."""

    type: Literal["generic"] = "generic"
    engine: Literal["opencut"] = "opencut"
    effect_type: str
    params: dict = Field(default_factory=dict)


FadiEffect = Annotated[
    Union[
        GradeEffect, RampEffect, LyricEffect, StrobeEffect, OverlayEffect, MorphEffect,
        MicrographicsEffect, BlobTrackEffect, GenericEffect,
    ],
    Field(discriminator="type"),
]


# ───────────────────────── elements (discriminated by `type`) ─────────────────────────

class BeatLock(BaseModel):
    """Marks that an element edge is locked to the song's beat grid, so re-timing the
    song (or nudging BPM) keeps the edit in sync."""

    beat_index: int
    downbeat: bool = False
    edge: Literal["start", "end"] = "start"


class BaseElement(BaseModel):
    id: str
    name: str = ""
    start_sec: float = Field(..., description="Position on the timeline.")
    duration_sec: float
    trim_start_sec: float = 0.0
    trim_end_sec: float = 0.0
    params: dict = Field(default_factory=dict)
    effects: list[FadiEffect] = Field(default_factory=list)
    beat_lock: Optional[BeatLock] = None


class VideoElement(BaseElement):
    type: Literal["video"] = "video"
    media_id: str
    retime_rate: float = 1.0
    source_audio_enabled: bool = False


class ImageElement(BaseElement):
    type: Literal["image"] = "image"
    media_id: str


class TextElement(BaseElement):
    type: Literal["text"] = "text"
    text: str = ""


class AudioElement(BaseElement):
    type: Literal["audio"] = "audio"
    media_id: Optional[str] = None
    source_url: Optional[str] = None
    retime_rate: float = 1.0


class GraphicElement(BaseElement):
    type: Literal["graphic"] = "graphic"
    definition_id: str


FadiElement = Annotated[
    Union[VideoElement, ImageElement, TextElement, AudioElement, GraphicElement],
    Field(discriminator="type"),
]


# ───────────────────────── tracks / scene / render spec ─────────────────────────

class FadiTrack(BaseModel):
    id: str
    name: str = ""
    type: Literal["video", "text", "audio", "graphic", "effect"]
    role: Literal["main", "overlay", "audio"] = "overlay"
    muted: bool = False
    hidden: bool = False
    elements: list[FadiElement] = Field(default_factory=list)


class RenderSpec(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: int = 24
    sample_rate: int = 44100
    output_codec: Literal["h264", "hevc", "prores"] = "h264"
    color_space: str = "bt709"
    proxy: bool = Field(False, description="True = fast proxy render for preview; False = final.")
    quality: Literal["draft", "standard", "high", "master"] = "high"


class FadiEDL(BaseModel):
    schema_version: str = SCHEMA_VERSION
    project_id: str
    name: str = "untitled"

    # Binds the whole edit to a SongContext (resolved by the Bridge for beats + lyrics).
    song_id: Optional[str] = None

    render: RenderSpec = Field(default_factory=RenderSpec)
    tracks: list[FadiTrack] = Field(default_factory=list)

    # Mirror of OpenCut Bookmarks — beat grid + section markers live here for the editor.
    beat_markers_sec: list[float] = Field(default_factory=list)
    section_markers: list[dict] = Field(default_factory=list)
