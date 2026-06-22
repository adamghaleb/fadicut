# Fadi ↔ OpenCut Contracts

The single source of truth shared by the Python **Fadi Bridge** and the TypeScript
**OpenCut** front-end. Two schemas:

| Contract      | Role                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SongContext` | The beat / lyric / section **spine**. Everything we know about a song: tempo + beat grid, sections, key/chords, word-aligned lyrics, audio refs.                                      |
| `FadiEDL`     | The **edit decision list** that crosses the browser→native boundary. Mirrors OpenCut's scene model (in seconds) + binds a `SongContext` + carries Fadi effect params for native bake. |

## Flow

```
Pydantic models ──► JSON Schema (dist/*.schema.json) ──► TS types
   (truth)            python codegen.py                   (OpenCut import)
```

Run `python codegen.py --ts-out <opencut>/src/fadi/contracts` to regenerate.
Bump `SCHEMA_VERSION` (in each module) on any breaking change.

## FadiEDL ↔ OpenCut mapping (base: `pre-rewrite`, `apps/web/src/timeline/types.ts`)

| OpenCut                                           | FadiEDL                                   | Note                                 |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| `MediaTime` (ticks)                               | `*_sec: float`                            | converted at the browser→EDL adapter |
| `SceneTracks {overlay, main, audio}`              | `FadiTrack.role`                          | flat list + role tag                 |
| `TimelineTrack` (video/text/audio/graphic/effect) | `FadiTrack.type`                          | same union                           |
| `TimelineElement`                                 | `FadiElement`                             | same discriminator (`type`)          |
| `Bookmark[]`                                      | `beat_markers_sec` + `section_markers`    | beat grid + sections ride bookmarks  |
| `RetimeConfig {rate}`                             | `VideoElement.retime_rate` / `RampEffect` | ramps                                |
| `Effect[]`                                        | `FadiElement.effects: FadiEffect[]`       | grade/strobe/overlay/lyric/morph     |
| graph-editor easing presets                       | `BezierCurve`                             | defaults to Adam's signature curve   |

## Effect → native engine (preview vs authoritative)

Every `FadiEffect` has a fast browser **preview** (same params) and a native
**authoritative** baker named by `engine`:

| Effect    | `engine`             | Native tool                                        |
| --------- | -------------------- | -------------------------------------------------- |
| `grade`   | `fadi_grade`         | HLS hue+sat substitution (Photoshop "Color" blend) |
| `ramp`    | `speedramp`          | speedramp.py + RIFE + motion blur                  |
| `lyric`   | `meandu`             | meandu-lyric-engine (PIL + HarfBuzz)               |
| `strobe`  | `fadi_strobe`        | luminance-preserving Fadi-color strobe             |
| `overlay` | `fadishoot_overlays` | beat-synced flash overlays                         |
| `morph`   | `morphloop`          | clipstitch / fadi-morphloop                        |
| `generic` | `opencut`            | OpenCut's own native effect (pass-through)         |

## Status

✅ Locked + round-trip validated (`python validate.py`). Safe for parallel swarm build.
