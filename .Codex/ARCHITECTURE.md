# Architecture

Focused records for components changed in this workspace.

## After Effects CEP panel: fadiFX

- `ae-plugins/com.fadi.fadifx/js/layer-fill.js`: static selected-layer actions and explicit in-panel drag target; separates static Fill from the existing animated color cycle. Only a same-panel matching drop commits an action; cancel and dragend do not mutate AE.
- `ae-plugins/com.fadi.fadifx/jsx/layer-fill.jsx`: ES3 host implementation for exact single-color or top-to-bottom ordered fills. Preflights all selected layers, owns only `fadiFX Swatch Fill`, preserves animation, and groups the bulk operation into one native Undo action. Included by `jsx/host.jsx`.
- `ae-plugins/com.fadi.fadifx/tests/layer-fill.test.cjs`: isolated AE-model tests for assignment, validation, preservation, and undo cleanup; native AE receipts are maintained separately in the task workspace.
- `ae-plugins/com.fadi.fadifx/FILL-LAYERS.md`: user controls and verified limitations for the static Fill workflow.
