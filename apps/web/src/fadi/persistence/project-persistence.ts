/**
 * Drive-backed project persistence with autosave + recovery (batch G, issue #7).
 *
 * This is the layer the editor uses instead of talking to IndexedDB directly for the
 * authoritative copy. It does NOT remove IndexedDB — it uses it as an offline mirror:
 *
 *   • Online (Bridge reachable):  authoritative = the Bridge (drive or its fallback dir).
 *                                 Every successful save is also mirrored to IndexedDB so a
 *                                 later drive-disconnect still has the latest bytes locally.
 *   • Offline (Bridge down / drive yanked mid-edit): saves queue to IndexedDB only and the
 *                                 status flips to "offline". When the Bridge comes back,
 *                                 `flush()` pushes the pending local copy up (with conflict
 *                                 detection via the stored rev).
 *
 * Conflict handling: each save carries the rev we last loaded. If another session bumped it
 * (the multi-session drive-clobber failure mode), the Bridge returns 409 → we surface it via
 * the `onConflict` callback rather than silently overwriting.
 *
 * Recovery: on load, if the Bridge had to read the EDL from its .bak snapshot, we flag it via
 * `recovered_from_backup` so the editor can prompt "recovered an earlier version — keep it?".
 */

import { FadiBridgeClient } from "./bridge-client";
import {
	BridgeUnavailableError,
	LoadResult,
	ProjectConflictError,
	ProjectDoc,
	ProjectMeta,
} from "./types";

export type PersistenceStatus =
	| "idle"
	| "saving"
	| "saved"
	| "offline" // Bridge/drive unreachable — saving to IndexedDB only
	| "conflict" // another session moved the rev
	| "error";

/** Minimal IndexedDB-mirror interface — satisfied by the editor's storage adapter.
 *  Kept structural so this module doesn't hard-depend on a specific adapter import. */
export interface LocalMirror {
	get(key: string): Promise<ProjectDoc | null>;
	set(args: { key: string; value: ProjectDoc }): Promise<void>;
	remove(key: string): Promise<void>;
}

export interface ProjectPersistenceOptions {
	client: FadiBridgeClient;
	/** Optional IndexedDB mirror for offline durability. Strongly recommended. */
	localMirror?: LocalMirror;
	/** Debounce window for autosave (ms). Default 1500. */
	debounceMs?: number;
	/** Fired whenever the status changes (drives the editor's save indicator). */
	onStatus?: (status: PersistenceStatus, detail?: string) => void;
	/** Fired on a 409 — the editor decides: reload-and-merge, or force-overwrite. */
	onConflict?: (info: { localRev: number; message: string }) => void;
	/** Fired after a load that was recovered from the Bridge's .bak snapshot. */
	onRecovered?: (doc: ProjectDoc) => void;
}

export class ProjectPersistence {
	private client: FadiBridgeClient;
	private local?: LocalMirror;
	private debounceMs: number;
	private onStatus?: ProjectPersistenceOptions["onStatus"];
	private onConflict?: ProjectPersistenceOptions["onConflict"];
	private onRecovered?: ProjectPersistenceOptions["onRecovered"];

	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending: ProjectDoc | null = null;
	private lastSavedRev = 0;
	private inFlight = false;

	constructor(opts: ProjectPersistenceOptions) {
		this.client = opts.client;
		this.local = opts.localMirror;
		this.debounceMs = opts.debounceMs ?? 1500;
		this.onStatus = opts.onStatus;
		this.onConflict = opts.onConflict;
		this.onRecovered = opts.onRecovered;
	}

	private setStatus(s: PersistenceStatus, detail?: string) {
		this.onStatus?.(s, detail);
	}

	/** Load a project; prefers the Bridge, falls back to the local mirror when offline. */
	async load(projectId: string): Promise<ProjectDoc> {
		try {
			const res: LoadResult = await this.client.loadProject(projectId);
			this.lastSavedRev = res.doc.meta.rev;
			// keep the local mirror warm
			await this.local?.set({ key: projectId, value: res.doc }).catch(() => {});
			if (res.recovered_from_backup) {
				this.onRecovered?.(res.doc);
			}
			return res.doc;
		} catch (err) {
			if (err instanceof BridgeUnavailableError && this.local) {
				const cached = await this.local.get(projectId);
				if (cached) {
					this.lastSavedRev = cached.meta.rev;
					this.setStatus("offline", "Bridge offline — loaded local copy");
					return cached;
				}
			}
			throw err;
		}
	}

	/** Queue an autosave. Coalesces rapid edits into a single debounced write. */
	scheduleSave(doc: ProjectDoc) {
		this.pending = doc;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), this.debounceMs);
	}

	/** Force-write the pending doc now (also called on the debounce timer, on unload, etc.). */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const doc = this.pending;
		if (!doc || this.inFlight) return;
		this.inFlight = true;
		this.pending = null;
		this.setStatus("saving");

		// Always mirror locally first — cheap, and guarantees an offline copy even if the
		// network write fails halfway.
		await this.local
			?.set({ key: doc.meta.project_id, value: doc })
			.catch(() => {});

		try {
			const result = await this.client.saveProject(doc, this.lastSavedRev);
			this.lastSavedRev = result.rev;
			// reflect the new rev/timestamp back into the local mirror
			const synced: ProjectDoc = {
				...doc,
				meta: {
					...doc.meta,
					rev: result.rev,
					updated_at: result.updated_at,
					storage_location: result.storage_location,
				},
			};
			await this.local
				?.set({ key: doc.meta.project_id, value: synced })
				.catch(() => {});
			this.setStatus(
				"saved",
				result.storage_location === "fallback"
					? "Saved (drive offline — using local fallback dir)"
					: undefined,
			);
		} catch (err) {
			if (err instanceof ProjectConflictError) {
				this.setStatus("conflict", err.message);
				this.onConflict?.({
					localRev: this.lastSavedRev,
					message: err.message,
				});
			} else if (err instanceof BridgeUnavailableError) {
				// drive/bridge gone — the local mirror already holds the bytes; retry on flush()
				this.pending = doc;
				this.setStatus(
					"offline",
					"Bridge offline — change saved locally, will sync",
				);
			} else {
				this.setStatus("error", (err as Error)?.message);
				throw err;
			}
		} finally {
			this.inFlight = false;
		}
	}

	/**
	 * Force-overwrite the Bridge with the local doc, ignoring the rev guard. Call this from
	 * the conflict UI's "keep my version" path. Re-syncs lastSavedRev afterward.
	 */
	async forceOverwrite(doc: ProjectDoc): Promise<void> {
		const result = await this.client.saveProject(
			doc /* no expectedRev → no guard */,
		);
		this.lastSavedRev = result.rev;
		this.setStatus("saved");
	}

	/**
	 * Re-attempt a queued offline save once the Bridge is back. Returns true if it pushed
	 * (or there was nothing pending), false if still offline.
	 */
	async syncIfOnline(): Promise<boolean> {
		if (!this.pending) return true;
		if (!(await this.client.isAvailable())) return false;
		await this.flush();
		return this.pending === null;
	}

	/** The rev we last successfully persisted — pass to a new editor session for conflict checks. */
	get rev(): number {
		return this.lastSavedRev;
	}
}

/** Build a ProjectMeta for a brand-new project (rev 0; the Bridge assigns rev 1 on first save). */
export function newProjectMeta(args: {
	projectId: string;
	title?: string;
	songId?: string | null;
	songName?: string | null;
}): ProjectMeta {
	const now = Date.now() / 1000;
	return {
		project_id: args.projectId,
		title: args.title ?? "untitled",
		song_id: args.songId ?? null,
		song_name: args.songName ?? null,
		rev: 0,
		created_at: now,
		updated_at: now,
		thumbnail_ref: null,
		storage_location: "drive",
		editor_state: {},
	};
}
