# Fadi Cut — Lyrics Sync Feature Spec

## Vision

Add a lyrics synchronization system to Fadi Cut that lets artists create CapCut-quality animated lyrics videos for their music. The system should handle the hardest part — timing lyrics to singing — through a hybrid approach: automated alignment gets you 80-90%, then a manual refinement UI handles the rest.

No custom model training required. No Whisper-on-vocals approach (which fails). Instead: vocal separation + forced alignment on known lyrics + manual correction.

---

## The Problem

Off-the-shelf transcription tools (Whisper, etc.) are trained on speech, not singing. They fail on musical vocals — especially stylized, unique artist voices. The current caption system in OpenCut (`buildCaptionChunks()`) only does chunk-level timing from Whisper segments, not word-level or syllable-level sync.

The artist already knows their lyrics. This is an **alignment** problem (when does each word land?), not a **transcription** problem (what is being said?).

---

## Core Architecture

### New Types

```typescript
// Word-level timing data
interface LyricWord {
	text: string;
	startTime: number; // seconds, relative to audio start
	endTime: number; // seconds
	confidence: number; // 0-1, from alignment model
	syllables?: LyricSyllable[]; // optional sub-word timing
}

interface LyricSyllable {
	text: string;
	startTime: number;
	endTime: number;
}

interface LyricLine {
	words: LyricWord[];
	startTime: number; // first word start
	endTime: number; // last word end
	lineIndex: number;
}

interface LyricsSyncData {
	lines: LyricLine[];
	bpm?: number; // detected BPM for quantization
	beatGrid?: number[]; // beat timestamps in seconds
	sourceFormat: "manual" | "lrc" | "srt" | "ass" | "aligned";
	alignmentModel?: string; // which model produced this
}

// Extends existing TextElement for lyrics-specific rendering
interface LyricsElement extends TextElement {
	type: "lyrics";
	syncData: LyricsSyncData;
	displayMode: "karaoke" | "line-by-line" | "word-pop";
	highlightStyle: LyricsHighlightStyle;
	preset?: LyricsPresetId;
}

interface LyricsHighlightStyle {
	activeColor: string; // color of currently-singing word
	inactiveColor: string; // color of not-yet-sung words
	completedColor: string; // color of already-sung words
	activeScale: number; // scale multiplier for active word (e.g. 1.2)
	activeWeight?: string; // font weight for active word
	transitionMs: number; // crossfade between words
	glowEnabled: boolean;
	glowColor?: string;
	glowRadius?: number;
}
```

### Where It Lives in the Codebase

| What              | Where                                        | Notes                                               |
| ----------------- | -------------------------------------------- | --------------------------------------------------- |
| New types         | `src/types/lyrics.ts`                        | LyricWord, LyricLine, LyricsSyncData, LyricsElement |
| Alignment service | `src/services/lyrics/alignment-service.ts`   | Orchestrates Demucs + forced alignment              |
| Vocal separation  | `src/services/lyrics/vocal-separator.ts`     | Demucs WASM or API call                             |
| Forced aligner    | `src/services/lyrics/forced-aligner.ts`      | CTC alignment via wav2vec2/SOFA                     |
| Beat detection    | `src/services/lyrics/beat-detector.ts`       | BPM + beat grid via librosa/essentia.js             |
| LRC/SRT parser    | `src/lib/lyrics/parsers.ts`                  | Import existing timed lyrics files                  |
| Lyrics renderer   | `src/services/renderer/nodes/lyrics-node.ts` | Extends TextNode for word-level highlight           |
| Sync editor UI    | `src/components/editor/panels/lyrics/`       | Tap-along, waveform, refinement                     |
| Timeline manager  | `src/core/managers/timeline-manager.ts`      | Extend to handle LyricsElement                      |
| Presets           | `src/constants/lyrics-presets.ts`            | Visual style presets                                |

---

## Feature Breakdown

### Phase 1: Manual Tap-Along Sync (Ship First, No ML)

The Hormozi-approved approach: build the manual tool first, automate later.

**1.1 — Lyrics Input Panel**

- New panel in the editor sidebar: "Lyrics"
- Paste raw lyrics text (plain text, one line per line)
- Import `.lrc`, `.srt`, or `.ass` files with existing timing data
- Auto-detect if imported file has word-level vs. line-level timing

**1.2 — Tap-Along Sync Mode**

- User clicks "Sync" to enter sync mode
- Audio plays at configurable speed (50%, 75%, 100%)
- Lyrics display one line at a time, large and centered
- User taps spacebar (or clicks) when each **line** starts
  - This captures line-level timing in one real-time pass (~4 min for a 4-min song)
- Within each line, words are auto-distributed proportionally to character count
  - Heuristic: longer words get proportionally more time
  - This gets you 70-80% accuracy with zero extra effort

**1.3 — Waveform Refinement Editor**

- After tap-along, show the audio waveform (WaveSurfer.js — already in the project)
- Word markers placed on the waveform from step 1.2
- User can drag individual word markers left/right to adjust timing
- Snap-to-transient option: detects audio energy peaks and snaps words to them
- Keyboard shortcut: select a word, press `[` / `]` to nudge timing by 50ms

**1.4 — Lyrics Preview on Canvas**

- Render lyrics on the Canvas 2D preview using a new `LyricsNode` (extends `TextNode`)
- Support three display modes:
  - **Karaoke**: all words visible, active word highlighted progressively
  - **Line-by-line**: current line fades in, previous line fades out
  - **Word-pop**: each word pops in individually with animation
- Use existing keyframe animation system for transitions

**1.5 — Export as Text Track**

- Lyrics sync data converts to a `TextTrack` with individual `TextElement` per line/word
- Each element has precise `startTime` and `duration` from sync data
- Existing export pipeline renders them to video

### Phase 2: Automated Alignment (After Manual Works)

**2.1 — Vocal Separation**

- Integrate Demucs (either WASM build or API endpoint)
- User uploads full mix → system extracts vocal stem
- Store isolated vocals in project assets for alignment

**2.2 — Forced Alignment**

- Use `lyrics-sync` library or CTC forced aligner (`ctc-forced-aligner`)
- Input: isolated vocal audio + lyrics text
- Output: word-level timestamps with confidence scores
- Feed directly into the same LyricsSyncData structure
- Low-confidence words get flagged for manual review

**2.3 — Note Onset Anchoring (Optional Enhancement)**

- Run Spotify's `basic-pitch` on isolated vocals
- Detect note onsets (when each musical note begins)
- Use onsets as anchor points to improve word boundary accuracy
- Merge onset data with forced alignment output

**2.4 — Beat Quantization**

- Detect BPM using `essentia.js` or `librosa` (via WASM/API)
- Build beat grid (every beat, half-beat, quarter-beat)
- Option to snap word timings to nearest beat subdivision
- Makes lyrics feel "musical" rather than just timestamped (Rick Rubin insight)

**2.5 — Hybrid Flow**

- Auto-alignment runs first → produces draft timing with confidence scores
- Results shown in the waveform refinement editor (Phase 1.3)
- Words with confidence < 0.7 highlighted in yellow for review
- User corrects the flagged words manually
- Total workflow: ~2 min automated + ~3 min manual correction per song

### Phase 3: Presets & Polish

**3.1 — Lyrics Animation Presets**

- A preset system for visual styles (inspired by CapCut's preset gallery)
- Each preset defines: colors, fonts, animation type, timing feel
- Initial presets:
  - **Clean Karaoke** — white text, yellow highlight, minimal
  - **Neon Glow** — dark bg, neon active word with glow
  - **Bounce Pop** — each word bounces in with spring animation
  - **Typewriter** — words appear letter-by-letter
  - **Fade Flow** — smooth opacity transitions between lines
  - **Street** — bold, high-contrast, urban aesthetic
  - **Handwritten** — script font, pen-stroke reveal
  - **Glitch** — digital glitch effect on active word

**3.2 — Per-Word Styling Override**

- Select any word in the timeline and override its style
- Useful for emphasizing key lyrics (chorus hooks, punchlines)
- Override: color, scale, animation, font weight

**3.3 — Background Sync Effects**

- Optional: pulse background opacity/color to the beat
- Uses beat grid from Phase 2.4
- Subtle but makes the whole video feel more alive

---

## Technical Integration Points

### Extending the Timeline System

The existing `TimelineTrack` union type needs a new variant:

```typescript
// In types/timeline.ts
type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| StickerTrack
	| EffectTrack
	| LyricsTrack;

interface LyricsTrack {
	type: "lyrics";
	id: string;
	name: string;
	elements: LyricsElement[];
}
```

### Extending the Renderer

New `LyricsNode` in `services/renderer/nodes/lyrics-node.ts`:

- Extends `TextNode` rendering logic
- At render time, receives current playback time
- Computes which word is active based on `syncData`
- Renders words with appropriate highlight states (active/inactive/completed)
- Applies animation interpolation for transitions between words

### Extending the Scene Builder

In `services/renderer/scene-builder.ts`, `buildScene()` needs a new case:

- When encountering a `LyricsElement`, create a `LyricsNode` instead of `TextNode`
- Pass `syncData` to the node so it can resolve word states at any timestamp

### Extending Timeline Manager

In `core/managers/timeline-manager.ts`:

- New method: `insertLyricsElement(trackId, lyricsElement)`
- New method: `updateLyricsTiming(elementId, syncData)` — for when user refines timing
- Commands: `InsertLyricsCommand`, `UpdateLyricsTimingCommand` (for undo/redo)

### Reusing Existing Infrastructure

| Existing System             | How Lyrics Uses It                                                |
| --------------------------- | ----------------------------------------------------------------- |
| `TextNode` canvas rendering | Base class for `LyricsNode` — font, layout, background            |
| Keyframe animation          | Animate word transitions (scale, opacity, color, position)        |
| `AnimationChannel`          | Per-word animation channels for presets                           |
| `WaveSurfer.js`             | Waveform display in the sync refinement editor                    |
| `buildCaptionChunks()`      | Reference implementation for chunking — lyrics uses similar logic |
| Command pattern (undo/redo) | All lyrics operations wrapped in commands                         |
| `extractTimelineAudio()`    | Extract audio for vocal separation                                |
| Transcription web worker    | Model for running alignment in a web worker                       |

---

## UX Flow (User's Perspective)

```
1. User imports their song into the timeline
2. Clicks "Lyrics" in the sidebar
3. Pastes their lyrics OR imports an .lrc/.srt file
4. If pasting raw lyrics:
   a. Clicks "Sync" → audio plays, user taps spacebar per line
   b. System auto-distributes words within each line
   c. Waveform editor opens → user drags words that feel off
   d. (Optional) clicks "Auto-Align" to run ML alignment, then corrects
5. If importing .lrc with timing:
   a. Timing data is parsed directly into LyricsSyncData
   b. Waveform editor opens for refinement
6. User picks a visual preset (or customizes)
7. Preview shows animated lyrics on the canvas in real-time
8. User exports video — lyrics baked into the render
```

---

## Dependencies

| Dependency                            | Purpose                       | Size/Impact             |
| ------------------------------------- | ----------------------------- | ----------------------- |
| None (Phase 1)                        | Manual sync needs no new deps | Zero                    |
| `demucs` (Phase 2)                    | Vocal separation              | WASM build or API       |
| `ctc-forced-aligner` or `lyrics-sync` | Forced alignment              | Python backend or WASM  |
| `basic-pitch` / `basic-pitch-ts`      | Note onset detection          | npm package exists      |
| `essentia.js`                         | BPM/beat detection            | Browser-compatible WASM |

Phase 1 (manual tap-along) has **zero new dependencies**. It only uses WaveSurfer.js (already in project) and the existing Canvas 2D renderer.

---

## Open Questions

1. **WASM vs. API for ML models?** Demucs and forced alignment are heavy. Running in-browser via WASM is possible but slow. Alternative: spin up a lightweight API (FastAPI + Demucs + aligner) that the editor calls. Decision deferred to Phase 2.

2. **Syllable-level or word-level?** Word-level is sufficient for most lyrics videos. Syllable-level matters for fast rap or melismatic singing. Start with word-level, add syllable mode as an option later.

3. **How to handle instrumental sections?** The sync editor needs a way to mark "no lyrics here" gaps. Could auto-detect from the alignment confidence or let the user mark sections.

4. **Preset marketplace?** Eventually, users could create and share presets. Out of scope for v1 but worth architecting the preset format to support it.

5. **Mobile?** The tap-along sync mode would work great on mobile (tapping is natural on a phone). Desktop-first but keep mobile feasibility in mind.

---

## Priority Order

```
Phase 1.1  Lyrics Input Panel              ██░░░░░░░░  Foundation
Phase 1.2  Tap-Along Sync Mode             ████░░░░░░  Core feature
Phase 1.4  Lyrics Canvas Renderer          ██████░░░░  Visual payoff
Phase 1.3  Waveform Refinement Editor      ████████░░  Polish
Phase 1.5  Export as Text Track            ██████████  Ship it
Phase 3.1  Animation Presets               ██████████  Delight
Phase 2.1  Vocal Separation                ██████████  Automation
Phase 2.2  Forced Alignment                ██████████  Automation
Phase 2.4  Beat Quantization               ██████████  Musical feel
Phase 2.5  Hybrid Flow                     ██████████  Best of both
Phase 2.3  Note Onset Anchoring            ██████████  Enhancement
Phase 3.2  Per-Word Styling                ██████████  Power users
Phase 3.3  Background Sync Effects         ██████████  Polish
```

Phase 1 is the MVP. Ship it, use it on real songs, learn what actually matters, then automate.
