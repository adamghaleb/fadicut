# Fadi Editor Kit

The root system for every editor Adam asks for. Vanilla ES modules, no build, no dependencies. Static-deployable (Vercel).
Seen working in two unrelated apps: Word Cloud Lab (word-cloud-lab.vercel.app) and `demo/` (coloured boxes).

## What you get
| Module | What |
|---|---|
| `createSelection` | click replaces · **shift/⌘-click adds** (on a selected item: stays, so shift-drag works; removed on release if you didn't drag) · click-inside-a-group keeps the group, collapses on release if no drag · select all / invert / Tab cycle · layer-list **range select** (`listClick`) |
| `createMarquee` | rubber-band: anything it **touches** (or `enclose`); **shift adds, alt subtracts**; locked/hidden skipped; jitter threshold |
| `groupBox / moveGroup / scaleGroup / rotateGroup / hitHandle` | shared bounding box, **8 handles** (12 px screen hit slop), scale about the opposite handle (**Alt = about the centre**, **Shift = proportional**, no flipping, min size), rotate ring outside corners (**Shift = 15°**) |
| `createSnapper` | smart guides to canvas edges/centres + other items' edges/centres, **8 screen-px** radius (feels the same at every zoom), guides returned for drawing |
| `align / distribute / zorder` | pure patch generators (⌘⌥ arrows, ⌘[ ⌘] ⌘⇧[ ⌘⇧]) |
| `attachEditorControls` | wires all of the above onto a container: pointer gestures, **Alt-drag duplicate after 2 px**, **Shift-drag axis lock with 8° hysteresis**, arrow nudge (⇧ ×10, ⌥ ÷4) with **runs of nudges merged into one undo step**, ⌘A / Esc / Tab, overlay (outlines, group box, handles, marquee, guides) |
| `createHistory` | snapshot undo/redo; **a gesture (drag/resize/slider) is ONE entry**, a no-op gesture leaves none |
| `createRegistry` | ONE shortcut table → handlers AND the `?` cheat sheet. Shifted symbols read from `e.code` (`mod+shift+]`, `shift+/`) |
| `attachTooltips` | `data-tip="Name|Key"` with keycaps, 400 ms delay |
| `createStore` / `createTasteLog` | debounced autosave (write-temp-then-swap, ⌘S flush) / every edit as before+after JSONL so the tool's own heuristics can be retuned from how Adam edits |
| `copyObjects / pasteObjects` | JSON clipboard that survives reloads |

## Wire it up (the adapter is the whole contract)
```js
import { createHistory, createRegistry, attachTooltips, attachEditorControls } from './vendor/fadi-editor-kit/src/index.js';
const history = createHistory({ getState: () => doc, setState: d => { doc = d; render(); } });
const registry = createRegistry().attach(); attachTooltips();
const ctl = attachEditorControls({ container, history, registry, taste /* optional createTasteLog */, adapter: {
  items: () => doc.items.map(o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, locked: o.locked, hidden: o.hidden })),
  patch: p => { for (const [id, f] of Object.entries(p)) Object.assign(find(id), f); render(); },   // must NOT push history
  toWorld: e => ({ x: e.clientX - rect.left, y: e.clientY - rect.top }), pxPerUnit: () => 1, canvas: { x: 0, y: 0, w: W, h: H },
  grid: 0, minSize: 8, remove: ids => {}, duplicate: ids => newIds, onSelect: ids => {}, onDraw: () => {},
}});
```
Options: `marqueeMode` ('touch'|'enclose'), `snapPx` (8), `rotate` (false), `proportionalDefault` (false; PhotoCraft is raster so it defaults true), `dupThreshold` (2 px), `axisHysteresisDeg` (8), `nudgeMergeMs` (700).
Call `ctl.redraw()` whenever the document changes outside a gesture, and `ctl.flush()` before ⌘S.

## Shortcuts it registers
⌘A select all · Esc cancel/deselect · Tab/⇧Tab next/prev · arrows nudge (⇧ ×10, ⌥ ÷4) · ⌘⌥←→↑↓ align · ⌘⌥C/M centre · ⌘⌥H/V distribute · ⌘] ⌘[ ⌘⇧] ⌘⇧[ z-order · ⌫/⌦ delete · ⌘D duplicate (when the adapter supports it).

## Provenance
Interaction rules were checked against PhotoCraft (MIT/Apache) and standard design-tool behaviour. See `docs/PHOTOCRAFT-NOTES.md` for what is verified, what PhotoCraft does NOT do, and what is unverified.

## Tests
`node tests/unit.mjs` (28 pure-math checks) · `node tests/demo.e2e.mjs` against `python3 -m http.server 5343` (14 browser checks). Word Cloud Lab has a 63-check suite using the kit.
