# Drive-backed project persistence (editor side) — batch G / issue #7

A typed client + autosave/recovery layer the OpenCut editor uses to persist a project as a
`FadiEDL` + meta JSON on disk (via the Fadi Bridge), **alongside** IndexedDB — IndexedDB is
not removed; it becomes the offline mirror.

## Files

| File                     | Role                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `types.ts`               | Wire shapes mirroring the frozen contract + Bridge `ProjectMeta`. Swap `FadiEDL` for codegen output when it lands.    |
| `retry.ts`               | Exponential-backoff retry (3×, 1s→2s→4s, jitter, 5xx+network only).                                                   |
| `bridge-client.ts`       | `FadiBridgeClient` — typed `/projects` REST calls, auth, timeout, retry, error mapping.                               |
| `project-persistence.ts` | `ProjectPersistence` — debounced autosave, rev-based conflict detection, offline IndexedDB mirror, recovery callback. |
| `index.ts`               | Barrel.                                                                                                               |

## Env

```bash
# apps/web/.env.local
NEXT_PUBLIC_FADI_BRIDGE_URL=http://127.0.0.1:8765   # default if unset
NEXT_PUBLIC_FADI_BRIDGE_TOKEN=<the token the Bridge printed at startup>
```

## Integration recipe (what the integrator wires)

```ts
import {
	createBridgeClientFromEnv,
	ProjectPersistence,
	newProjectMeta,
	type LocalMirror,
} from "@/fadi/persistence";

const client = createBridgeClientFromEnv(); // null if no Bridge configured
// Adapt the existing IndexedDB project adapter to the LocalMirror shape (get/set/remove):
const localMirror: LocalMirror = {
	/* wrap services/storage adapter */
};

const persistence = new ProjectPersistence({
	client: client!,
	localMirror,
	onStatus: (s, detail) => setSaveIndicator(s, detail), // idle|saving|saved|offline|conflict|error
	onConflict: ({ message }) => openConflictDialog(message),
	onRecovered: (doc) => promptKeepRecovered(doc),
});

// load
const doc = await persistence.load(projectId);

// on every timeline mutation (build the EDL from the OpenCut scene at the edge):
persistence.scheduleSave({ meta, edl });

// on tab close / route change:
window.addEventListener("beforeunload", () => void persistence.flush());

// when the network/drive comes back:
await persistence.syncIfOnline();
```

## Drive / offline behavior

- The Bridge picks the projects root live: `FADI_PROJECTS_ROOT` → `<drive>/FADICUT-PROJECTS`
  (Seagate) → `~/Documents/fadicut-projects` fallback. `getRoot()` reports which is active and
  whether the drive is mounted, so the editor can show "saving to local fallback".
- If the Bridge is unreachable mid-edit, saves go to the IndexedDB mirror and status flips to
  `offline`; `syncIfOnline()` pushes the pending copy up when it returns.

## Conflict (multi-session drive clobber)

Each save carries the rev last loaded. If another session bumped it, the Bridge returns `409`
→ `onConflict` fires. Resolve via reload (`load`) or `forceOverwrite(doc)`.

## Recovery

If the Bridge had to read the EDL from its `.bak` snapshot (main `edl.json` was corrupt /
half-written), `load()` fires `onRecovered(doc)` so the editor can confirm with the user.
