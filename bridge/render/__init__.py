"""Render orchestrator (batches B/C/D).

Batch A intentionally ships this empty. Later batches add one adapter per effect
`engine` (fadi_grade, speedramp, meandu, fadi_strobe, fadishoot_overlays, morphloop)
and register them as job runners on the shared queue, e.g.::

    from jobs import register_runner
    register_runner("render_grade", grade_runner)

without editing the Bridge core. The render lane mapping convention: grade/RIFE/ramp →
the "gpu" lane (concurrency 1 on the M2); lyric/overlay/morph compositing → "cpu";
proxy/asset IO → "io".

Batch D (grade + speed-ramp) ships two GPU-lane runners here. The integrator wires them
on app startup with a single call::

    from render import register_batch_d_runners
    register_batch_d_runners()   # registers render_grade + render_ramp on the queue

or registers them individually::

    from jobs import register_runner
    from render.fadi_grade import grade_runner
    from render.speedramp import ramp_runner
    register_runner("render_grade", grade_runner)   # lane="gpu"
    register_runner("render_ramp", ramp_runner)      # lane="gpu"

Both runners belong on the **gpu** lane (RIFE / grade frame-walks serialize on the M2).
"""

from .blob_track import bake_blob_track, blob_track_runner
from .fadi_grade import bake_grade, grade_runner
from .fadi_strobe import bake_strobe, strobe_runner, strobe_video
from .fadishoot_overlays import bake_overlay, overlay_runner
from .morphloop import bake_morph, morph_runner
from .speedramp import bake_ramp, ramp_runner

# kind → (runner, recommended lane). The integrator reads RENDER_RUNNERS to wire the
# queue; nothing here imports the queue at module load (open/closed, import-safe).
#
# Lane convention: grade/RIFE/ramp → "gpu" (concurrency 1 on the M2); strobe/overlay/
# morph compositing → "cpu"; proxy/asset IO → "io".
RENDER_RUNNERS: dict[str, tuple] = {
    "render_grade": (grade_runner, "gpu"),
    "render_ramp": (ramp_runner, "gpu"),
    "render_strobe": (strobe_runner, "cpu"),
    "render_overlay": (overlay_runner, "cpu"),
    "render_morph": (morph_runner, "cpu"),
    "render_blob_track": (blob_track_runner, "cpu"),
}


def register_batch_d_runners() -> None:
    """Register grade + ramp runners on the shared job queue (call once at startup)."""
    from jobs import register_runner

    for kind in ("render_grade", "render_ramp"):
        register_runner(kind, RENDER_RUNNERS[kind][0])


def register_effect_runners() -> None:
    """Register every per-effect baker runner (grade, ramp, strobe, overlay, morph) on
    the shared job queue. Call once at startup. Idempotent-safe only if not already
    registered (the queue raises on duplicate kinds), so guard at the call site."""
    from jobs import register_runner

    for kind, (runner, _lane) in RENDER_RUNNERS.items():
        try:
            register_runner(kind, runner)
        except ValueError:
            # already registered (e.g. grade/ramp via register_batch_d_runners) — skip.
            pass


__all__: list[str] = [
    "bake_grade",
    "grade_runner",
    "bake_ramp",
    "ramp_runner",
    "bake_strobe",
    "strobe_video",
    "strobe_runner",
    "bake_overlay",
    "overlay_runner",
    "bake_morph",
    "morph_runner",
    "bake_blob_track",
    "blob_track_runner",
    "RENDER_RUNNERS",
    "register_batch_d_runners",
    "register_effect_runners",
]
