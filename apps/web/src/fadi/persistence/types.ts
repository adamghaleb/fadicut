/**
 * Local TS mirrors of the drive-backed persistence wire shapes.
 *
 * These intentionally mirror the FROZEN Python contract
 * (contracts/fadi_contracts/fadi_edl.py) plus the Bridge's project bookkeeping
 * (bridge/projects/models.py). When `codegen.py` emits real contract TS into
 * `@/fadi/contracts`, swap `FadiEDL` below for the generated type and delete the
 * inline copy — the rest of this module is written against these names so the swap
 * is a one-import change.
 *
 * Times in the EDL are SECONDS (float), per the contract. OpenCut's MediaTime ticks
 * are converted at the browser↔EDL adapter, NOT here.
 */

// ── EDL (mirror of fadi_edl.py — kept minimal/structural; treat as opaque if codegen lands) ──

export interface FadiEDL {
	schema_version: string;
	project_id: string;
	name: string;
	song_id?: string | null;
	render?: Record<string, unknown>;
	tracks: unknown[];
	beat_markers_sec?: number[];
	section_markers?: Record<string, unknown>[];
	// allow forward-compatible extra fields without losing them on round-trip
	[k: string]: unknown;
}

// ── Project bookkeeping (mirror of bridge/projects/models.py:ProjectMeta) ──

export interface ProjectMeta {
	project_id: string;
	title: string;
	song_id?: string | null;
	song_name?: string | null;
	rev: number;
	created_at: number;
	updated_at: number;
	thumbnail_ref?: string | null;
	/** "drive" | "fallback" | "explicit" — where the file currently lives. */
	storage_location: string;
	editor_state?: Record<string, unknown>;
}

export interface ProjectDoc {
	meta: ProjectMeta;
	edl: FadiEDL;
}

export interface ProjectListing {
	project_id: string;
	title: string;
	song_id?: string | null;
	song_name?: string | null;
	rev: number;
	updated_at: number;
	thumbnail_ref?: string | null;
	storage_location: string;
}

export interface SaveResult {
	project_id: string;
	rev: number;
	updated_at: number;
	storage_location: string;
}

export interface LoadResult {
	doc: ProjectDoc;
	/** True when the Bridge had to recover the EDL from its .bak snapshot. */
	recovered_from_backup: boolean;
}

export interface RecoveryInfo {
	project_id: string;
	recovered_from_backup: boolean;
	edl_ok: boolean;
	backup_present: boolean;
	rev: number;
	updated_at: number;
}

export interface ProjectRootInfo {
	root: string;
	/** "explicit" | "drive" | "fallback" */
	location: string;
	drive_available: boolean;
}

// ── client config + error ──

export interface BridgeClientConfig {
	/** Base URL of the local Fadi Bridge, e.g. "http://127.0.0.1:8765". */
	baseUrl: string;
	/** Shared bearer token the Bridge was started with. */
	token: string;
	/** Per-request timeout (ms). Default 15000. */
	timeoutMs?: number;
}

/** A conflict raised when the stored rev moved under us (multi-session clobber). */
export class ProjectConflictError extends Error {
	readonly status = 409;
	constructor(message: string) {
		super(message);
		this.name = "ProjectConflictError";
	}
}

/** Bridge unreachable / drive offline / 5xx exhausted retries. */
export class BridgeUnavailableError extends Error {
	readonly status = 503;
	constructor(message: string) {
		super(message);
		this.name = "BridgeUnavailableError";
	}
}

export class BridgeRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "BridgeRequestError";
	}
}
