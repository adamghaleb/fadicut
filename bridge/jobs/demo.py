"""A no-op demo job that proves the queue + SSE progress path end-to-end.

It just sleeps in `steps` increments, emitting a progress frame each tick, then returns
a small result. Payload knobs:
  steps:    int   (default 5)   — number of progress ticks
  delay:    float (default 0.2) — seconds between ticks
"""

from __future__ import annotations

import asyncio

from .models import Job


async def demo_noop_runner(job: Job, progress) -> dict:
    steps = int(job.payload.get("steps", 5))
    delay = float(job.payload.get("delay", 0.2))
    steps = max(1, min(steps, 1000))

    for i in range(steps):
        await asyncio.sleep(delay)
        await progress((i + 1) / steps, f"step {i + 1}/{steps}")

    return {"ok": True, "steps": steps, "echo": job.payload.get("echo")}
