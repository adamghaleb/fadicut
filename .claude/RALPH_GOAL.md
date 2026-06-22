# Fadiloop Goal — fadicut premium end-to-end product

Repo: `~/Documents/windsurf projects/fadicut` (branch `main`). Bridge: `cd bridge && ./run.sh` (port 8765). Frozen contracts in `contracts/` — DO NOT modify. Use ffmpeg-full for drawtext. Discard the prettier formatting churn before each commit (`git checkout -- .` on unrelated tracked files; stage only real paths).

## Done-criteria (verify each before moving on; commit per milestone)

1. `bun install` succeeds on `apps/web`; `bunx tsc --noEmit` (or the web typecheck) is clean for the Fadi code under `apps/web/src/components/editor/panels/fadi/**` and `apps/web/src/fadi/**`. Fix type errors against the real OpenCut APIs.
2. All 4 Fadi panels (lyrics, beatgrid, effects, library) are mounted into OpenCut's panel registry / `panels/assets/assets-panel-store` and render in the editor.
3. The editor connects to the Bridge: a connection config (base URL + token from `apps/web/.env`), a small status/connect UI, and ideally Bridge auto-launch. Token from the Bridge log.
4. The me&u lyric slice works end-to-end in the running dev server: pick song → beat-synced lyric track placed → "bake" calls the Bridge `render_lyric` job and streams progress. Verify with the dev server + Bridge both running (use Playwright MCP to drive the browser and confirm).
5. Drive-backed save/load (batch G) wired to replace or mirror IndexedDB via the `apps/web/src/fadi/persistence` client + Bridge `/projects`.
6. Polished, cohesive Fadi-styled UI across all panels (consistent spacing, Fadi color accents, clean empty/loading/offline states). Premium feel.
7. Close GitHub issues #2, #3, #4, #5, #7 (`gh issue close <n> --repo adamghaleb/fadicut`) as each lands, with a status comment.

## Working method

- Use subagents for parallel/independent slices to keep context clean.
- Run the dev server + Bridge and actually verify behavior (Playwright MCP) — don't claim done without proof.
- Commit each milestone with a clear message (Co-Authored-By line per repo convention). Push to `main`.
- Track progress in `tasks/todo.md`; update `tasks/lessons.md` on any correction.
- NEVER use broad `pkill`; kill specific PIDs from `lsof -ti :<port>`.

## Completion

When ALL seven done-criteria are verified passing and pushed, output the promise: `<promise>FADICUT_COMPLETE</promise>`
