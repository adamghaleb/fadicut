"""Bridge configuration — read once from the environment at startup.

Everything is localhost-first and overridable by env var so fadigrid (port/process
manager) can pin the port and inject a token. Nothing here reaches the network beyond
the loopback interface unless explicitly reconfigured.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


def _split_csv(val: str | None) -> list[str]:
    if not val:
        return []
    return [p.strip() for p in val.split(",") if p.strip()]


@dataclass(frozen=True)
class Settings:
    # ── network / bind ──────────────────────────────────────────────────────
    host: str = "127.0.0.1"          # loopback only — never 0.0.0.0 by default
    port: int = 8765

    # ── auth ────────────────────────────────────────────────────────────────
    # A shared bearer token. If unset, one is generated at startup and printed to
    # the log so the editor can be configured. Health is always unauthenticated.
    token: str = ""

    # ── CORS ────────────────────────────────────────────────────────────────
    # Locked to the OpenCut dev origin(s). Comma-separated env override.
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000"]
    )

    # ── media ───────────────────────────────────────────────────────────────
    # Roots the range-media endpoint is allowed to serve from. Any requested file
    # must resolve (realpath) inside one of these — prevents path traversal off-drive.
    media_roots: list[Path] = field(default_factory=list)

    # ── jobs ────────────────────────────────────────────────────────────────
    gpu_concurrency: int = 1         # GPU lane: RIFE / grade — serialized on the M2
    cpu_concurrency: int = 4
    io_concurrency: int = 8

    @property
    def cors_origin_set(self) -> set[str]:
        return set(self.cors_origins)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    token = os.environ.get("FADI_BRIDGE_TOKEN", "").strip()
    if not token:
        token = secrets.token_urlsafe(24)

    cors = _split_csv(os.environ.get("FADI_BRIDGE_CORS_ORIGINS"))
    if not cors:
        cors = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Media roots: env CSV, else default to the user's home (the indexer in batch E
    # narrows this via asset_roots.toml). Each is expanded + resolved.
    roots_env = _split_csv(os.environ.get("FADI_BRIDGE_MEDIA_ROOTS"))
    if not roots_env:
        roots_env = [str(Path.home())]
    media_roots = []
    for r in roots_env:
        try:
            media_roots.append(Path(r).expanduser().resolve())
        except OSError:
            # Unmounted drive etc. — keep the literal expanded path so it works once mounted.
            media_roots.append(Path(r).expanduser())

    return Settings(
        host=os.environ.get("FADI_BRIDGE_HOST", "127.0.0.1"),
        port=int(os.environ.get("FADI_BRIDGE_PORT", "8765")),
        token=token,
        cors_origins=cors,
        media_roots=media_roots,
        gpu_concurrency=int(os.environ.get("FADI_BRIDGE_GPU_CONCURRENCY", "1")),
        cpu_concurrency=int(os.environ.get("FADI_BRIDGE_CPU_CONCURRENCY", "4")),
        io_concurrency=int(os.environ.get("FADI_BRIDGE_IO_CONCURRENCY", "8")),
    )
