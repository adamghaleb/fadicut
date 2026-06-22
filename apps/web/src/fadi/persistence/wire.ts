/**
 * Wire-up adapter: mirror OpenCut projects to the Fadi Bridge / drive ALONGSIDE IndexedDB
 * (batch G, issue #7).
 *
 * IndexedDB stays the authoritative local store for the editor. This module adds a
 * **non-fatal** drive mirror on top:
 *
 *   • `mirrorProjectToBridge(project)` — best-effort push of the current project's EDL + meta
 *     to the Bridge. Never throws into the editor; logs and returns on any failure.
 *   • `loadProjectFromBridge(projectId)` — best-effort pull of a previously-mirrored doc
 *     (e.g. to recover when IndexedDB is empty). Returns null if unavailable.
 *   • `initDriveSync(...)` — tiny init that constructs the shared `ProjectPersistence` and
 *     wires status callbacks; safe to call once at editor startup.
 *
 * If the Bridge isn't configured (no env), or is offline, or the drive is yanked, every call
 * degrades to a no-op / IndexedDB-only path. Local editing is never blocked.
 */

import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import type { TProject } from "@/project/types";
import { projectToEdl, projectToMeta } from "./edl-adapter";
import { createBridgeClientFromEnv, FadiBridgeClient } from "./bridge-client";
import {
	newProjectMeta,
	ProjectPersistence,
	type LocalMirror,
	type PersistenceStatus,
} from "./project-persistence";
import type { ProjectDoc } from "./types";

/** Dedicated IndexedDB store for the drive-mirror copies — separate from the editor's own DB. */
const MIRROR_DB = "fadi-drive-mirror";
const MIRROR_STORE = "project-docs";

/**
 * LocalMirror implemented over IndexedDB. The persistence layer's `set` passes a plain
 * `ProjectDoc`; `IndexedDBAdapter` stores it under `{ id: key, ...value }`, so on read we
 * strip the injected `id` back out to hand a clean `ProjectDoc` to callers.
 */
function createIndexedDbMirror(): LocalMirror {
	const adapter = new IndexedDBAdapter<ProjectDoc & { id?: string }>({
		dbName: MIRROR_DB,
		storeName: MIRROR_STORE,
		version: 1,
	});

	return {
		async get(key: string): Promise<ProjectDoc | null> {
			const raw = await adapter.get(key);
			if (!raw) return null;
			const { id: _id, ...doc } = raw;
			return doc as ProjectDoc;
		},
		async set({
			key,
			value,
		}: {
			key: string;
			value: ProjectDoc;
		}): Promise<void> {
			await adapter.set({ key, value: value as ProjectDoc & { id?: string } });
		},
		async remove(key: string): Promise<void> {
			await adapter.remove(key);
		},
	};
}

interface DriveSyncState {
	client: FadiBridgeClient | null;
	persistence: ProjectPersistence | null;
	mirror: LocalMirror | null;
	onStatus?: (status: PersistenceStatus, detail?: string) => void;
}

const state: DriveSyncState = {
	client: null,
	persistence: null,
	mirror: null,
};

/** Track the last-known rev per project so re-mirrors carry conflict protection. */
const revByProject = new Map<string, number>();

/**
 * Construct (once) the shared drive-sync layer. Safe to call multiple times — later calls
 * just refresh the status callback. No-op surface if the Bridge isn't configured.
 */
export function initDriveSync(opts?: {
	onStatus?: (status: PersistenceStatus, detail?: string) => void;
}): void {
	if (opts?.onStatus) state.onStatus = opts.onStatus;
	if (state.persistence) return;

	try {
		const client = createBridgeClientFromEnv();
		state.client = client;
		if (!client) return; // no Bridge configured → mirror calls become no-ops

		const mirror = createIndexedDbMirror();
		state.mirror = mirror;
		state.persistence = new ProjectPersistence({
			client,
			localMirror: mirror,
			onStatus: (s, detail) => state.onStatus?.(s, detail),
		});
	} catch (err) {
		// Never let wiring failure break the editor.
		console.warn("[fadi/drive-sync] init failed (non-fatal):", err);
		state.client = null;
		state.persistence = null;
	}
}

function ensurePersistence(): ProjectPersistence | null {
	if (!state.persistence) initDriveSync();
	return state.persistence;
}

/**
 * Best-effort mirror of the current project to the Bridge / drive. Builds the EDL from the
 * live `TProject`, schedules a debounced autosave, and tracks the rev. Fully non-fatal.
 */
export function mirrorProjectToBridge(project: TProject): void {
	try {
		const persistence = ensurePersistence();
		if (!persistence) return; // Bridge not configured — IndexedDB-only, nothing to do.

		const projectId = project.metadata.id;
		const rev = revByProject.get(projectId) ?? 0;
		const edl = projectToEdl({ project });
		const meta = {
			...projectToMeta({ project, rev }),
			// keep a stable created_at if we have a baseline meta from a prior load
			...(rev === 0
				? newProjectMeta({
						projectId,
						title: project.metadata.name,
					})
				: {}),
		};
		// projectToMeta is the source of truth for live fields; just make sure ids line up.
		meta.project_id = projectId;
		meta.rev = rev;

		const doc: ProjectDoc = { meta, edl };
		persistence.scheduleSave(doc);
		// Reflect the persistence layer's authoritative rev back into our map after a flush.
		void Promise.resolve().then(() => {
			revByProject.set(projectId, persistence.rev);
		});
	} catch (err) {
		console.warn("[fadi/drive-sync] mirror failed (non-fatal):", err);
	}
}

/** Force any pending mirror to flush now (e.g. on tab close / route change). Non-fatal. */
export async function flushDriveSync(): Promise<void> {
	try {
		await state.persistence?.flush();
	} catch (err) {
		console.warn("[fadi/drive-sync] flush failed (non-fatal):", err);
	}
}

/**
 * Best-effort load of a project doc from the Bridge (drive) — used as a fallback source when
 * IndexedDB has nothing. Returns null on any failure (Bridge down, drive offline, not found).
 */
export async function loadProjectFromBridge(
	projectId: string,
): Promise<ProjectDoc | null> {
	try {
		const persistence = ensurePersistence();
		if (!persistence) return null;
		const doc = await persistence.load(projectId);
		revByProject.set(projectId, doc.meta.rev);
		return doc;
	} catch (err) {
		console.warn("[fadi/drive-sync] load failed (non-fatal):", err);
		return null;
	}
}

/** Re-attempt a queued offline mirror once the Bridge/drive returns. Non-fatal. */
export async function syncDriveIfOnline(): Promise<void> {
	try {
		await state.persistence?.syncIfOnline();
	} catch (err) {
		console.warn("[fadi/drive-sync] sync failed (non-fatal):", err);
	}
}
