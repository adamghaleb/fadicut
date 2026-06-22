# Fadi Bridge

Local FastAPI service (localhost only) that owns files, the M2 GPU, and the native Fadi
tools. The OpenCut editor talks to it; it never runs in the browser.

## Responsibilities

- **REST API** — commands + queries (library, SongContext, submit render).
- **SSE/WebSocket** — progress streams for long jobs (renders, RIFE).
- **Range-media server** — serves proxies/originals off the drive to the browser `<video>`.
- **Job queue** — lanes with concurrency caps: **GPU lane = 1** (RIFE/grade), CPU lane, IO lane.
- **Render orchestrator** — consumes a `FadiEDL`, calls the right native tool per effect `engine`.
- **Asset indexer** — walks `asset_roots.toml` into a SQLite catalog (hash, codec, duration, proxy, tags).

## Layout

```
api/     FastAPI routes + the typed contract (imports ../contracts)
jobs/    queue, lanes, SSE progress
assets/  indexer, proxy cache, search
render/  EDL → native pipeline; one adapter per engine (fadi_grade, speedramp, meandu, …)
```

## Engines (wrap existing CLIs — never reimplement)

| engine               | tool                           |
| -------------------- | ------------------------------ |
| `meandu`             | meandu-lyric-engine            |
| `fadi_grade`         | HLS hue+sat substitution grade |
| `speedramp`          | speedramp.py + RIFE            |
| `fadi_strobe`        | Fadi-color strobe              |
| `fadishoot_overlays` | beat-synced flash overlays     |
| `morphloop`          | clipstitch / fadi-morphloop    |

Bind: localhost only, token auth, CORS locked to the OpenCut origin. Register with fadigrid
for port/process management.
