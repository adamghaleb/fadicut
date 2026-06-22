# Fadicut

Adam's BPM/lyric-native video editor — the OpenCut editor wired to the whole FadiFiles
pipeline (meandu lyrics, beat detection, speedramp+RIFE, Fadi grade, clipstitch/morphloop,
fadishoot overlays), drawing media from every Fadi-style asset source incl. the Seagate drive.

## Architecture

OpenCut runs in the **browser**; a local **Fadi Bridge** (FastAPI) owns files, the M2 GPU,
and the native tools. They talk over localhost: REST (commands) + SSE (job progress) +
range-media (Bridge streams proxies off the drive). Final renders are **native** (full
ffmpeg / RIFE / PIL-HarfBuzz), never ffmpeg.wasm.

```
apps/web/   OpenCut full editor (base: pre-rewrite) + Fadi panels
bridge/     FastAPI — api/ jobs/ assets/ render/  (job queue, GPU lane=1)
contracts/  SongContext + FadiEDL (Pydantic → JSON Schema → TS). The frozen interface.
ae-plugins/ 4 Fadi CEP extensions (fadifx, fadirange, fadistrobe, srt-importer) + install.sh
```

### The spine

`SongContext` (BPM, beat grid, sections, word-aligned lyrics) is the coordinate system
the timeline binds to. `FadiEDL` is the timeline→native-render hand-off; it mirrors
OpenCut's scene model so the browser→EDL adapter is 1:1. See `contracts/README.md`.

### Effects: preview vs authoritative

Every Fadi effect renders an approximate **browser preview** while editing and a native
**authoritative bake** on final render, from the same params. `engine` names the baker.

## Build batches (GitHub issues)

- **A** Bridge core · **B** Lyric slice (spike) · **C** BPM/beat grid · **D** Grade+Ramp
- **E** Asset manager (roots in `bridge/asset_roots.toml`) · **F** AE plugins · **G** Drive-backed projects

## Setup

```
bun install                 # editor
./ae-plugins/install.sh     # link AE/PS panels
# bridge: see bridge/README.md (batch A)
```
