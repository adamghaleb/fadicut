# Fadi Cut — BPM-Based Editing System Spec

## Vision

Transform Fadi Cut from a generic video editor into a **music-video-first editor** where the beat is the fundamental unit of time. Instead of only thinking in frames and seconds, users can edit in bars, beats, and subdivisions. Effects repeat on beat. Cuts snap to the grid. The entire editing paradigm understands music.

Think: what if Ableton Live and CapCut had a baby.

---

## Core Concept: The Dual-Timeline

Every DAW solves this problem: musical time (bars/beats) and absolute time (seconds/frames) are two views of the same data. Fadi Cut needs the same duality.

### The Tempo Map

A first-class object that lives at the project level:

```typescript
interface TempoMap {
	entries: TempoEntry[];
	ppq: number; // pulses per quarter note — 960 is the modern standard
	defaultTimeSignature: TimeSignature;
}

interface TempoEntry {
	time: number; // seconds (absolute position)
	bpm: number;
	timeSignature: TimeSignature;
}

interface TimeSignature {
	numerator: number; // beats per bar (e.g. 4)
	denominator: number; // note value (e.g. 4 = quarter note)
}
```

### Musical Position

Every element on the timeline can be expressed in either time system:

```typescript
interface MusicalPosition {
	bar: number; // 1-indexed
	beat: number; // 1-indexed within bar
	subdivision: number; // 0-1 fractional position within beat
	tick: number; // absolute tick from start (derived)
}

// Bidirectional conversion
function ticksToSeconds(ticks: number, tempoMap: TempoMap): number;
function secondsToTicks(seconds: number, tempoMap: TempoMap): number;
function ticksToMusicalPosition(
	ticks: number,
	tempoMap: TempoMap,
): MusicalPosition;
function musicalPositionToTicks(
	pos: MusicalPosition,
	tempoMap: TempoMap,
): number;
```

### Timeline Display Modes

The user can switch the timeline ruler between:

| Mode             | Ruler Shows                           | Grid Snaps To                      | Best For             |
| ---------------- | ------------------------------------- | ---------------------------------- | -------------------- |
| **Bars & Beats** | `1.1 \| 1.2 \| 1.3 \| 1.4 \| 2.1 ...` | Bar, beat, half-beat, quarter-beat | Music-synced editing |
| **Seconds**      | `0:00 \| 0:01 \| 0:02 ...`            | Seconds, 100ms, frames             | Traditional editing  |
| **Frames**       | `1 \| 2 \| 3 ...`                     | Per-frame                          | Precision work       |

The toggle is a single button in the timeline toolbar. All three views show the same data — just different labels and snap points.

---

## Feature Breakdown

### Phase 1: BPM Detection & Beat Grid

**1.1 — Auto BPM Detection**

When the user imports an audio track:

1. Run browser-based beat detection (energy peak method via Web Audio API) for instant feedback (~2 sec)
2. Optionally run essentia.js WASM analysis for higher accuracy (~5-10 sec)
3. Display detected BPM with confidence indicator
4. Auto-generate a beat grid overlay on the timeline

Detection pipeline:

```
Audio file
  → Decode to AudioBuffer (Web Audio API)
  → Lowpass filter at 150Hz (isolate kick/bass)
  → Peak detection with threshold
  → Interval grouping → BPM estimate
  → Beat position array (timestamps in seconds)
```

**1.2 — Manual BPM Controls**

Always available as override:

- **Tap Tempo button** — tap along, system averages intervals
- **BPM number input** — type exact value
- **Half / Double buttons** — fix octave errors (most common detection failure: 140 BPM detected as 70 or 280)
- **Beat offset slider** — shift the beat grid left/right to align beat 1 with the actual downbeat
- **"Set Bar 1 Here" marker** — click on the waveform to mark where bar 1 starts

**1.3 — Beat Grid Overlay**

Visual overlay on the timeline:

- **Bar lines** — bold, numbered (1, 2, 3...)
- **Beat lines** — medium weight, numbered within bar (1.1, 1.2, 1.3, 1.4)
- **Subdivision lines** — light/dotted (8th notes, 16th notes)
- Grid opacity is adjustable
- Grid lines appear/disappear based on zoom level (like a map)

**1.4 — Snap-to-Beat**

Extend the existing timeline snap system:

- Current snapping: element edges, playhead
- New snap targets: bar lines, beat lines, half-beats, quarter-beats
- Snap strength is configurable: off / beat / half-beat / 16th note
- When dragging elements, they magnetically snap to the nearest beat subdivision

---

### Phase 2: Musical Editing Units

**2.1 — Duration Input in Musical Units**

Anywhere the user sets a duration, they can type:

- `4 bars` → duration = 4 bars at current BPM
- `2 beats` → duration = 2 beats
- `1/2 bar` → half a bar
- Or still use `3.5s` / `90 frames` for absolute time

The system converts between units using the tempo map.

**2.2 — Loop Region by Bars**

- User can select a region on the timeline in bar units: "loop bars 5-8"
- The region snaps to bar boundaries
- Audio loops seamlessly within that region
- Perfect for previewing a hook or chorus section

**2.3 — Hook Extraction**

Smart loop detection for music:

1. User imports a full song
2. System analyzes structure (verse, chorus, bridge) using repetition detection
3. User picks a section (e.g., the hook) → system trims to exact bar boundaries
4. One-click to loop that section

Implementation approach:

- Use spectral similarity / self-similarity matrix to find repeating sections
- Snap detected section boundaries to the beat grid
- Present sections as clickable colored regions on the waveform

**2.4 — Copy/Paste by Musical Position**

- "Copy bars 1-4" → paste at bar 9 → elements land on the same beat positions relative to the bar
- Effects, text, cuts — everything copies in musical time
- Paste adjusts to current BPM if it changed between copy and paste locations

---

### Phase 3: Beat-Synced Effects

**3.1 — The Beat Ramp Primitive**

The core abstraction (borrowed from TouchDesigner/Resolume): a **ramp signal** that goes from 0.0 to 1.0 every N beats, then resets.

```typescript
interface BeatRamp {
	beatDivision: BeatDivision; // how often it cycles
	phase: number; // 0-1 offset from the downbeat
	easing: EasingFunction; // linear, easeIn, easeOut, bounce, etc.
	waveform: "ramp" | "sine" | "triangle" | "square" | "pulse";
}

type BeatDivision =
	| "4bars"
	| "2bars"
	| "1bar"
	| "2beats"
	| "1beat"
	| "1/2beat"
	| "1/4beat"
	| "1/8beat"
	| "1/16beat";
```

Any effect parameter can be **driven by a beat ramp**. The ramp value (0-1) maps to a parameter range.

Example: "Flash to white on every beat"

```json
{
	"effect": "brightness",
	"driver": {
		"type": "beatRamp",
		"beatDivision": "1beat",
		"waveform": "pulse",
		"easing": "easeOut"
	},
	"mapping": { "min": 0, "max": 100 }
}
```

**3.2 — Beat-Synced Effect Library**

Built-in effects that understand BPM:

| Effect             | What It Does                      | Default Beat Division |
| ------------------ | --------------------------------- | --------------------- |
| **Flash**          | Brightness spike on beat          | 1 beat                |
| **Pulse Scale**    | Element scales up/down on beat    | 1 beat                |
| **Strobe**         | Rapid black/white flashing        | 1/4 beat              |
| **Shake**          | Camera shake triggered on beat    | 1 bar                 |
| **Color Cycle**    | Hue rotation synced to bars       | 1 bar                 |
| **Zoom Pulse**     | Zoom in on beat, ease back out    | 2 beats               |
| **Glitch**         | RGB split + displacement on beat  | 1/2 beat              |
| **Vignette Pulse** | Vignette intensity on beat        | 1 beat                |
| **Blur Sweep**     | Blur in/out per bar               | 1 bar                 |
| **Cut Trigger**    | Auto-switch between clips on beat | 1 bar / 2 bars        |

Each effect has:

- A beat division selector (dropdown: 4 bars → 1/16 beat)
- An intensity slider
- A phase offset knob (shift the trigger point within the beat)
- An easing curve selector

**3.3 — Auto-Cut to Beat**

The VJ-inspired feature:

1. User imports multiple video clips
2. Selects all of them
3. Clicks "Auto-Cut to Beat"
4. System arranges clips on the timeline, each lasting exactly N bars/beats
5. Cuts align perfectly to the beat grid
6. User picks the cut rhythm: every bar, every 2 beats, alternating, random-within-grid

**3.4 — Audio-Reactive Parameters**

For effects that respond to the actual audio (not just BPM):

```typescript
interface AudioReactiveDriver {
	type: "audioReactive";
	band: "bass" | "mid" | "treble" | "full";
	smoothing: number; // 0-1, prevents jitter
	threshold: number; // minimum energy to trigger
	mapping: { min: number; max: number };
}
```

Uses Web Audio API's `AnalyserNode` to get real-time FFT data:

- Bass (20-250Hz) → great for kick-triggered effects
- Mid (250-2kHz) → vocals, melodies
- Treble (2k-20kHz) → hi-hats, cymbals

---

### Phase 4: Preset System (AI-Generatable)

**4.1 — Preset Format**

Inspired by ISF (Interactive Shader Format) and AE presets. A preset is a JSON file that describes a reusable combination of effects, animations, and beat-sync settings.

```typescript
interface FadiPreset {
	id: string;
	name: string;
	description: string;
	version: 1;
	author: string;
	tags: string[];

	// What this preset applies to
	target: "clip" | "text" | "track" | "global";

	// Effect stack
	effects: PresetEffect[];

	// Animation keyframes (in beat-relative time)
	animations: PresetAnimation[];

	// Parameters the user can tweak after applying
	parameters: PresetParameter[];
}

interface PresetEffect {
	type: string; // 'flash', 'glitch', 'scale', 'blur', etc.
	driver: BeatRamp | AudioReactiveDriver | "static";
	properties: Record<string, number | string>;
}

interface PresetAnimation {
	property: string; // 'transform.scale', 'opacity', 'color', etc.
	keyframes: BeatKeyframe[];
	loopMode: "once" | "repeat" | "pingpong";
}

interface BeatKeyframe {
	beat: number; // position in beats (0 = start, 1 = one beat in)
	value: number | string;
	easing: EasingFunction;
}

interface PresetParameter {
	name: string;
	label: string;
	type: "number" | "color" | "boolean" | "select";
	default: any;
	min?: number;
	max?: number;
	options?: string[];
	description: string;
}
```

**4.2 — Applying Presets**

1. User selects an element (clip, text, track)
2. Opens preset browser
3. Previews preset (live preview on the canvas, beat-synced)
4. Clicks apply → effect stack + animations added to the element
5. Tweakable parameters appear in the properties panel

**4.3 — Creating Presets in the Editor**

Users can create presets two ways:

**Manual:** Configure effects + animations on an element → right-click → "Save as Preset" → name it → saved to local preset library.

**Via LLM:** This is the differentiator.

1. User opens the "Create Preset" dialog
2. Types a natural language description: _"Neon flash on every beat with a purple-to-cyan color cycle over each bar, slight zoom pulse on the downbeat"_
3. System sends the description + the FadiPreset JSON schema to the language model
4. Model generates a valid FadiPreset JSON
5. System applies it instantly to the selected element as a live preview
6. User can iterate: _"Make the flash more subtle, and add a glitch effect on every 4th beat"_
7. When satisfied, save to preset library

**4.4 — LLM Integration Architecture**

```typescript
interface PresetGenerationRequest {
	prompt: string;
	currentBpm: number;
	currentTimeSignature: TimeSignature;
	targetType: "clip" | "text" | "track" | "global";
	existingEffects?: PresetEffect[]; // for iteration
	schema: JSONSchema; // the FadiPreset schema for structured output
}

interface PresetGenerationResponse {
	preset: FadiPreset;
	explanation: string; // LLM explains what it created
}
```

The model receives:

- The full FadiPreset JSON schema (so it outputs valid JSON)
- The current BPM and time signature (so beat divisions make sense)
- What type of element it's being applied to
- Any existing effects (for iterative refinement)

This uses Claude's structured output / tool use to guarantee valid JSON output.

**4.5 — Preset Library & Sharing**

- Presets are stored as `.fadi-preset.json` files
- Local library: `~/.fadi-cut/presets/`
- Project-local presets: `project/presets/`
- Future: community preset marketplace (users share presets)
- Presets are small (< 10KB each) — just JSON, no binary assets

---

## Technical Integration into OpenCut

### New Files

```
src/
  types/
    bpm.ts                          # TempoMap, MusicalPosition, BeatRamp, BeatDivision
    preset.ts                       # FadiPreset, PresetEffect, PresetAnimation, PresetParameter
  core/
    managers/
      bpm-manager.ts                # BPM detection, tempo map, beat grid state
      preset-manager.ts             # Preset CRUD, apply, save, LLM generation
  services/
    bpm/
      beat-detector.ts              # Web Audio API peak detection (fast)
      essentia-analyzer.ts          # Essentia.js WASM analysis (accurate)
      tempo-map.ts                  # Tick ↔ seconds ↔ musical position conversion
    presets/
      preset-engine.ts              # Apply preset to element, resolve beat ramps
      preset-generator.ts           # LLM integration for generating presets
  lib/
    bpm/
      conversions.ts                # ticksToSeconds, secondsToTicks, etc.
      snap.ts                       # Beat-aware snapping logic
      beat-grid.ts                  # Beat grid computation for timeline overlay
    presets/
      schema.ts                     # JSON schema for FadiPreset (for LLM)
      validators.ts                 # Validate preset JSON
  components/
    editor/
      panels/
        bpm/
          bpm-controls.tsx          # BPM display, tap tempo, half/double, offset
          beat-grid-overlay.tsx      # Visual grid on timeline
          time-mode-toggle.tsx       # Switch bars/seconds/frames
        presets/
          preset-browser.tsx         # Browse + preview presets
          preset-creator.tsx         # Manual + LLM preset creation
          preset-parameter-editor.tsx # Tweak applied preset params
        effects/
          beat-synced-effects.tsx    # Beat division selector, audio-reactive controls
  constants/
    bpm-constants.ts                # Default BPM, snap quantizations, beat divisions
    preset-library.ts               # Built-in preset definitions
```

### Extending Existing Files

**`src/types/timeline.ts`**

- Add `tempoMap: TempoMap` to the project/scene type
- Add optional `musicalPosition?: MusicalPosition` to `BaseTimelineElement`
- Add optional `beatDivision?: BeatDivision` to element duration fields

**`src/core/managers/timeline-manager.ts`**

- New methods: `setTempoMap()`, `snapTobeat()`, `getMusicalPosition()`
- Extend `insertElement()` to accept musical positions
- Extend `updateElementTrim()` to snap to beat grid

**`src/services/renderer/canvas-renderer.ts`**

- At render time, resolve beat ramp values for the current frame
- Pass `currentBeatRamp` values to nodes that have beat-synced effects

**`src/services/renderer/nodes/` (all visual nodes)**

- Extend rendering to apply beat-ramp-driven effects (flash, scale, color, etc.)
- New `EffectResolver` that takes `(currentTime, tempoMap, beatRamp)` → effect values

**`src/lib/timeline/` (snap utilities)**

- Add beat-aware snap targets alongside existing pixel-based snapping

**`src/stores/` (Zustand)**

- New `bpm-store.ts`: detected BPM, manual override, beat grid, current beat position
- New `preset-store.ts`: loaded presets, applied presets, LLM conversation state

---

## The Beat Ramp Resolution Pipeline

How beat ramps get resolved at render time:

```
1. Renderer requests frame at time T (seconds)
2. Convert T to ticks via tempoMap: ticks = secondsToTicks(T, tempoMap)
3. For each element with beat-synced effects:
   a. Get element's beat ramp configs
   b. For each ramp:
      - Calculate position within the ramp's cycle:
        cycleLength = beatDivisionToTicks(ramp.beatDivision, tempoMap)
        positionInCycle = (ticks + ramp.phase * cycleLength) % cycleLength
        normalizedPosition = positionInCycle / cycleLength  // 0.0 - 1.0
      - Apply waveform shaping:
        if ramp.waveform === 'sine': value = sin(normalizedPosition * 2π) * 0.5 + 0.5
        if ramp.waveform === 'ramp': value = normalizedPosition
        if ramp.waveform === 'pulse': value = normalizedPosition < 0.1 ? 1.0 : 0.0
        etc.
      - Apply easing: value = ramp.easing(value)
      - Map to parameter range: paramValue = lerp(mapping.min, mapping.max, value)
   c. Apply resolved parameter values to the element's render properties
4. Render the frame with all beat-synced values applied
```

---

## Quantized Speed Multipliers

Following Resolume and TouchDesigner's convention, beat divisions are restricted to musically meaningful values:

```
4 bars  →  16 beats  (slow sweep)
2 bars  →  8 beats
1 bar   →  4 beats   (standard)
2 beats →  2 beats
1 beat  →  1 beat    (most common)
1/2     →  0.5 beats (8th note)
1/4     →  0.25 beats (16th note)
1/8     →  0.125 beats
1/16    →  0.0625 beats (fast strobe)
```

These appear as a dropdown or clickable chips — not a continuous slider. This prevents musically nonsensical values.

---

## UX Flow Examples

### "I want flashing on beat"

```
1. Import song → BPM auto-detected (128 BPM)
2. Add a video clip to the timeline
3. Select the clip → open Effects panel
4. Add "Flash" effect
5. Beat Division dropdown: select "1 beat"
6. Intensity slider: 80%
7. Preview: clip flashes bright on every beat
8. Tweak: change to "1/2 beat" for double-time flashing
```

### "I want to loop the hook"

```
1. Import full song
2. Timeline shows beat grid overlay
3. Switch timeline to "Bars & Beats" mode
4. Drag-select bars 17-24 (the hook)
5. Right-click → "Loop Selection"
6. Audio loops seamlessly between bars 17-24
7. Edit video elements within this loop region
```

### "Create a preset with AI"

```
1. Select a text element
2. Click "Create Preset" → opens dialog
3. Type: "Each word bounces in from below on every beat,
   with a neon blue glow that pulses on the downbeat,
   and a subtle RGB split that intensifies during
   the chorus"
4. Claude generates a FadiPreset JSON
5. Live preview shows the effect immediately
6. User: "Make the bounce more aggressive and the glow warmer"
7. Claude adjusts the preset
8. User clicks "Save Preset" → "Neon Word Bounce" added to library
```

---

## Dependencies

| Dependency                 | Purpose                                                      | Phase |
| -------------------------- | ------------------------------------------------------------ | ----- |
| Web Audio API (built-in)   | Fast beat detection, FFT analysis, audio-reactive params     | 1     |
| `essentia.js`              | Accurate offline BPM/beat detection (WASM)                   | 1     |
| Claude API / Anthropic SDK | LLM preset generation                                        | 4     |
| None else for Phase 1-3    | All beat-sync logic is pure math on existing canvas renderer | —     |

---

## Open Questions

1. **Ableton Link support?** Would let DJs/VJs sync Fadi Cut to their live setup. Cool but niche. Defer unless demand emerges.

2. **Variable tempo support?** Songs with tempo changes need multiple tempo entries in the map. Phase 1 assumes constant BPM. Variable tempo is Phase 2+.

3. **Audio time-stretching?** If the user changes BPM, should audio stretch to match? This requires granular synthesis (complex). Defer — focus on editing to the detected BPM, not changing it.

4. **Preset versioning?** If a preset references an effect type that gets renamed/removed in a future version, it breaks. Need a version field and migration strategy. Keep it simple for now — `version: 1`.

5. **WebGPU for effects?** The existing renderer uses Canvas 2D + WebGL for effects. Beat-synced effects with shaders would benefit from WebGPU. But browser support is still uneven. Stick with WebGL for now.

6. **MIDI input?** A MIDI controller could drive beat divisions and effect parameters in real-time. Extremely cool for live VJ use. Web MIDI API exists. Defer to post-v1.

---

## Priority Order

```
Phase 1.1  Auto BPM Detection              ██░░░░░░░░  Foundation
Phase 1.2  Manual BPM Controls             ███░░░░░░░  Always needed
Phase 1.3  Beat Grid Overlay               █████░░░░░  Visual payoff
Phase 1.4  Snap-to-Beat                    ██████░░░░  Core UX
Phase 2.1  Musical Duration Input          ██████░░░░  Quality of life
Phase 2.2  Loop Region by Bars             ███████░░░  Music workflow
Phase 3.1  Beat Ramp Primitive             ███████░░░  Effect foundation
Phase 3.2  Beat-Synced Effect Library      ████████░░  The wow factor
Phase 3.3  Auto-Cut to Beat                ████████░░  VJ feature
Phase 3.4  Audio-Reactive Parameters       █████████░  Advanced
Phase 4.1  Preset Format                   █████████░  Ecosystem
Phase 4.3  LLM Preset Creation             ██████████  Differentiator
Phase 2.3  Hook Extraction                 ██████████  Smart feature
Phase 4.5  Preset Library & Sharing        ██████████  Community
```

---

## Relationship to Lyrics Sync Spec

The BPM system is the **foundation** that lyrics sync builds on:

- Lyrics timing can snap to the beat grid (Rick Rubin insight: quantize to musical time)
- Lyrics animation presets use the same beat ramp primitive
- The LLM preset system generates both visual effects AND lyrics animation styles
- Beat detection runs once per audio import — both systems share the result

The two specs are complementary, not competing. BPM is infrastructure; lyrics sync is a feature built on that infrastructure.
