# Fadi AE/CEP Plugins

Four After Effects CEP panels that bring Fadi looks into AE, plus a lyric→SRT
exporter that feeds the SRT Importer from the Fadi contracts. They are the **AE-side
mirror** of the Fadi Bridge's native bakers: a panel previews/applies a look natively
inside AE the same way the Bridge bakes it for OpenCut renders. Where a panel control
corresponds to a Bridge engine param, the [Params-Parity](#params-parity) table makes
the mapping explicit so the two stay in sync.

> Scope: this directory is fully self-contained (Batch F / issue #6). It does not
> import or modify the frozen contracts; the exporter only _reads_ them.

## Install

```bash
./install.sh
```

`install.sh` is idempotent. It:

1. enables unsigned CEP extensions by setting `PlayerDebugMode 1` for CSXS **9–12**
   (AE 2018 → current), and
2. symlinks each `com.fadi.*` panel into
   `~/Library/Application Support/Adobe/CEP/extensions/`.

Then restart After Effects → **Window ▸ Extensions ▸ \<panel\>**. Re-run the script
after pulling new panels; existing symlinks are refreshed (`ln -sfn`).

To uninstall, delete the symlinks from the CEP extensions dir. To disable debug mode,
`defaults delete com.adobe.CSXS.<v> PlayerDebugMode`.

## The four panels

| Panel                   | Menu              | What it does                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.fadi.fadifx`       | fadiFX            | Color-cycle / strobe over time. Animates a layer through the Fadi palette (ordered or custom order), forward / pingpong, with optional opacity strobe and a pulse waveform.                                                                                                                                |
| `com.fadi.fadirange`    | fadiRange         | Flagship range × preset × modulation grade. Targets the whole layer, a luma band, or a picked color, then applies a preset (Recolor / Cycle / Mosaic / Posterize / Glow / threshold looks), optionally strobe-modulated, over a layer / work-area / custom time span. Live WebGL preview → native AE bake. |
| `com.fadi.fadistrobe`   | fadiStrobe        | Opacity strobe. Drives a layer's opacity between min/max on an on/off frame cadence (square / random / pulse style), with per-layer stagger.                                                                                                                                                               |
| `com.fadi.srt-importer` | Fadi SRT Importer | Imports an `.srt` into the active comp as timed Source-Text — either one layer with hold keyframes, or one layer per cue. Pairs with the **lyric→SRT exporter** below.                                                                                                                                     |

All panels share a small UI kit (`css/fadi-ui.css` + `js/fadi-ui.js` in the
srt-importer; the others ship their own `styles.css`), sync to AE's theme color at
runtime, and talk to AE through an ExtendScript host (`jsx/host.jsx`) via
`csInterface.evalScript()`. Settings cross the JS→JSX boundary as a JSON string;
host.jsx parses it (ExtendScript is ES3, so the SRT importer ships a hand-rolled
ES3-safe JSON parser rather than evaluating panel input).

### SRT Importer details

- **Source**: an `.srt` file (loaded via `cep.fs.showOpenDialog`, with a hidden
  `<input type=file>` fallback for browser/dev runs).
- **Parser** (`js/srt-parser.js`): tolerant of BOM, `\r\n`/`\r`, missing index lines,
  and `,`/`.` millisecond separators; optionally strips `<i>`/`<font>` HTML tags and
  `{\anN}` ASS overrides; converts cue line breaks to `\r` (AE's text line separator);
  sorts cues and reports a `skipped` count for malformed blocks.
- **Import modes**:
  - **One Layer** — a single text layer with Source-Text hold keyframes (empty text in
    the gaps between cues).
  - **Layer Per Cue** — one text layer per cue, in/out trimmed to the cue, stacked in
    order.
- **Style controls**: font size, vertical position (% of comp height, centered),
  strip-tags on/off.
- **Dev harness** (`dev/`): `index-dev.html` + `mock-csi.js` + `debug-panel.js` mock
  `CSInterface`/`cep.fs` so the panel runs and is debuggable in a plain browser without
  AE.

## Lyric → SRT exporter

`exporter/lyric_to_srt.py` — the Bridge-side companion to the SRT Importer. It converts
a contract **`SongContext`** (or the lyric track of a **`FadiEDL`**) into an `.srt`
that the panel imports. Round-trip verified: exporter output parses back through
`js/srt-parser.js` byte-for-cue identically.

```bash
# every lyric line in a song
python exporter/lyric_to_srt.py --song song_context.json -o lyrics.srt

# word-aligned karaoke (one cue per Word)
python exporter/lyric_to_srt.py --song song_context.json --by word -o lyrics.srt

# only the lyrics a FadiEDL actually uses (resolved against the SongContext),
# offset onto the timeline by each lyric element's start_sec
python exporter/lyric_to_srt.py --edl edl.json --song song_context.json -o lyrics.srt
```

Behavior:

- Reads the **frozen** contracts (`contracts/fadi_contracts/{song_context,fadi_edl}.py`)
  — located automatically by walking up to `fadicut/contracts`, or via
  `FADI_CONTRACTS_DIR`. Never modifies them.
- `--by line` (default): one cue per `LyricLine`. `--by word`: one cue per `Word`,
  falling back to a line cue when a line has no word alignment.
- `--edl` mode: for each element carrying a `lyric` (engine=`meandu`) effect, it slices
  the bound song's lyrics by the effect's `line_range` (matched against
  `LyricLine.index`), re-bases them so the first selected line lands at the element's
  `start_sec`, and emits cues. With no lyric effects present it exports the whole song.
- Contract times are **seconds**; SRT timestamps are `HH:MM:SS,mmm`. Overlapping cues
  are clipped to be monotonic (SRT players assume non-overlapping cues).

This closes the loop: lyrics authored anywhere upstream (song-pipeline `catalog.json`
→ `SongContext`, or an edited `FadiEDL`) can be dropped into AE as timed subtitles.

## Params-Parity

How each panel's controls map to the Bridge native engines named in the contracts
(`contracts/README.md` → "Effect → native engine"). The panels apply looks _inside AE_;
the Bridge bakes the _authoritative_ render for OpenCut. These are the knobs that must
mean the same thing on both sides.

### fadiRange → `fadi_grade` (`GradeEffect`, engine `fadi_grade`)

`fadi_grade` = HLS hue+sat substitution preserving L from a B&W base (Photoshop "Color"
blend). `GradeEffect` fields: `mode`, `fadi_color`, `preset`, `params`.

| fadiRange control                     | value space                                                                                                  | `GradeEffect` mapping                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `mode` (Range)                        | 0 Whole · 1 Luma · 2 Color                                                                                   | selects what the grade targets → carried in `params.range` (`whole`/`luma`/`color`)                |
| `mode` ↔ grade `mode`                 | Color+Recolor → `hls_substitution`; Cycle → `rainbow`; hue presets → `hue_shift`; outline preset → `outline` | maps onto `GradeEffect.mode`                                                                       |
| `preset`                              | 0 Recolor · 1 Cycle · 2 Mosaic · 3 Posterize · 4 Glow · 5+ threshold looks                                   | `GradeEffect.preset` (string name) + `params.preset_index`                                         |
| `duoColor` / target                   | hex                                                                                                          | `GradeEffect.fadi_color` (single-color substitution)                                               |
| `target` (picked RGB)                 | `[r,g,b]` 0..1                                                                                               | `params.color_target` (color-mode key)                                                             |
| `tolerance`                           | 0..1                                                                                                         | `params.color_tolerance`                                                                           |
| `lumaLo` / `lumaHi`                   | 0..1                                                                                                         | `params.luma_lo` / `params.luma_hi` (luma-band gate)                                               |
| `feather`                             | 0..1                                                                                                         | `params.feather`                                                                                   |
| `mosaic`                              | px                                                                                                           | `params.mosaic` (Mosaic preset)                                                                    |
| `poster`                              | levels                                                                                                       | `params.posterize` (Posterize preset)                                                              |
| `threshold`                           | 0..1                                                                                                         | `params.threshold` (threshold presets)                                                             |
| `modulation` + `onFrames`/`offFrames` | frames                                                                                                       | strobe modulation of the grade → `params.modulation` `{on_frames, off_frames}` (see strobe parity) |
| `span` + `tStart`/`tEnd`              | layer · work · custom (seconds)                                                                              | not a grade param — sets the element's `start_sec`/`duration_sec` on the `FadiElement`             |
| `fadi` (palette)                      | hex[]                                                                                                        | the Fadi color set; for Cycle/rainbow → `params.palette`                                           |

### fadiStrobe → `fadi_strobe` (`StrobeEffect`, engine `fadi_strobe`)

`StrobeEffect` fields: `palette`, `every_n_frames`, `luminance_preserve`.

| fadiStrobe control          | value space               | `StrobeEffect` mapping                                                                                                                                                                        |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFrames`                  | frames the layer is "on"  | with `offFrames` → `every_n_frames = onFrames + offFrames` (the strobe period)                                                                                                                |
| `offFrames`                 | frames the layer is "off" | combines into `every_n_frames`; exact on/off split → `params.duty {on,off}`                                                                                                                   |
| `style`                     | square · random · pulse   | `params.style` (waveform shape of the strobe)                                                                                                                                                 |
| `maxOpacity` / `minOpacity` | 0..100                    | `params.max_opacity` / `params.min_opacity`. The contract default look is **luminance-preserving** (`luminance_preserve=true`), i.e. opacity strobe over a graded base rather than a hard cut |
| `stagger`                   | frames                    | `params.stagger` (per-instance phase offset)                                                                                                                                                  |
| `matchLayer`                | bool                      | authoring convenience (match strobe length to layer) → not serialized                                                                                                                         |
| `totalDuration`             | seconds                   | sets the element's `duration_sec`, not a strobe param                                                                                                                                         |
| (panel uses Fadi palette)   | hex[]                     | `StrobeEffect.palette`                                                                                                                                                                        |

> Note on `fadiFX`: the fadiFX panel (color-cycle) is the AE expression of the same
> `fadi_strobe`/`fadi_grade` family — its `colors` → `palette`, `frameDuration` →
> `every_n_frames`, `strobeOn`/`strobeGap` → the strobe duty, `direction`
> (forward/pingpong), `waveformMode`+`pulseSpeed` → `params.style`. It is a faster,
> palette-cycling subset of fadiRange's Cycle preset and bakes through the same
> `fadi_grade`/`fadi_strobe` engines.

## File layout

```
ae-plugins/
├── install.sh                       # symlink + PlayerDebugMode (CSXS 9–12)
├── README.md                        # this file
├── com.fadi.fadifx/                 # color-cycle panel
├── com.fadi.fadirange/              # flagship grade panel (WebGL preview + native bake)
├── com.fadi.fadistrobe/             # opacity-strobe panel
└── com.fadi.srt-importer/           # SRT → AE text panel  (+ exporter/, dev/)
    ├── CSXS/manifest.xml
    ├── index.html
    ├── css/{fadi-ui.css, styles.css}
    ├── js/{fadi-ui.js, srt-parser.js, main.js}
    ├── jsx/host.jsx                 # ES3 host: JSON parse + import modes + styling
    ├── lib/CSInterface.js
    ├── exporter/lyric_to_srt.py     # SongContext / FadiEDL → .srt
    └── dev/                         # browser dev harness (mock CSInterface/cep.fs)
```

Each panel folder is a standard CEP extension: `CSXS/manifest.xml` (AEFT host,
`PlayerDebugMode`-gated), `index.html`, `css/`, `js/`, `jsx/host.jsx`, `lib/CSInterface.js`.
