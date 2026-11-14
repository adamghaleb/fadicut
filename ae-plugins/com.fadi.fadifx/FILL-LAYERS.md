# Fill layers

Choose **Fill layers** in fadiFX, then select one or more visual layers in an After Effects composition.

- Click a color square to apply that exact static Fill color to every selected layer.
- Click **Ordered** to assign the enabled palette from left to right to selected layers from top to bottom. The palette repeats after its last color.
- Drag a square or Ordered into **Drop to fill selected layers** for the same action. Direct drops onto AE timeline clips are not implemented. Releasing outside this box or cancelling does nothing.
- Alt-click or right-click a color to exclude/include it in Ordered.
- Use Tab then Enter/Space to activate controls. Use AE's **Edit > Undo** (Cmd+Z) to undo a bulk fill.
- **Animate** keeps the existing animated color-cycle controls.

The effect appears as **fadiFX Swatch Fill**. Repeating an action updates that effect instead of piling up duplicates. Other effects remain intact. An owned Fill with animated color/opacity is protected and must be renamed or preserved separately before recoloring. Locked, audio-only and unsupported layers stop the whole action before any changes.

## Installation and verification

The six changed runtime files were copied into the existing installed CEP extension with hash verification and a full pre-update backup. Close and reopen only the fadiFX panel to load the new UI; no AE restart is needed for the file update. Native panel reloading is verified separately before it is reported complete.

11 automated host tests pass. Native AE tests verified nine selected layers, all seven exact RGB colors, top-to-bottom wrapping, static opacity, repeat updates without duplicates, disabled-fill recovery, and whole-selection rejection. Native UI and Undo verification status is recorded in the task receipt.
