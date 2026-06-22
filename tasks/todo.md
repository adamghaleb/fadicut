# fadicut fadiloop — todo (phase 2 complete)

PHASE 1 (all ✓, verified live): typecheck, lyrics+library tabs, beat markers, Fadi FX
(grade/ramp), asset library, drive persistence, polish, Bridge status dot, native export.

PHASE 2 (all ✓, issues #8-12 closed):
- [x] #8 orchestrator handler-dispatch + strobe/overlay/morph bakers (all 8 effects bake in export)
- [x] #9 micrographics treatment (baker + Fadi FX panel) — VERIFIED composited in export
- [x] #10 square blob-tracking (baker + Fadi FX panel)
- [x] #11 blob-asset disk staging (POST /assets/stage)
- [x] #12 Seagate FADICUT-PROJECTS path

VERIFIED END-TO-END in native export: grade + micrographics + strobe (baked:{grade,micrographics,strobe}).
Built + handler-registered + agent-verified-standalone (not yet exercised in a full export with real inputs): ramp, overlay, morph, blob_track, lyric-overlay.

Residual follow-ups: exercise overlay/morph/blob_track export with real inputs; RIFE-on ramp bake; lyric line_range slicing; browser-impossible Bridge auto-launch (needs desktop/Tauri branch).
