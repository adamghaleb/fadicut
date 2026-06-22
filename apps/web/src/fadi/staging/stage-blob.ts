/**
 * Blob-asset disk staging client (issue #11).
 *
 * An editor `MediaAsset` carries a browser `File` (its `.file`) — in-memory bytes with
 * NO disk path. The native Fadi bakers and the render orchestrator all operate on files
 * on disk, so before such an asset can be referenced in a FadiEDL it must be materialised
 * on the Bridge. This helper does exactly that and returns the absolute staged path.
 *
 * Flow:
 *   1. Hash the blob (SHA-256, Web Crypto) → the content key.
 *   2. Probe `GET /assets/stage/{hash}` — if the Bridge already has it on disk, reuse the
 *      path with zero bytes uploaded (the cache survives across sessions).
 *   3. Otherwise `POST /assets/stage` the bytes (multipart) and use the returned path.
 *
 * Every request gets the bearer token, a timeout, and exponential-backoff retry (5xx +
 * network only, never 4xx) — the same discipline as the persistence client. Env/URL/token
 * are read the same way too (NEXT_PUBLIC_FADI_BRIDGE_URL / _TOKEN).
 *
 * NOT wired into the export button here — that's phase 3. This module only exposes
 * `stageBlobAsset()` (+ low-level `stageBlob` / `stageBlobFile`).
 */

import { withRetry } from "../persistence/retry";
import {
	BridgeRequestError,
	BridgeUnavailableError,
} from "../persistence/types";

const DEFAULT_TIMEOUT_MS = 60_000; // uploads can be larger than a JSON save

export interface StageBlobConfig {
	/** Base URL of the local Fadi Bridge, e.g. "http://127.0.0.1:8765". */
	baseUrl: string;
	/** Shared bearer token the Bridge was started with. */
	token: string;
	/** Per-request timeout (ms). Default 60000. */
	timeoutMs?: number;
}

export interface StagedAsset {
	/** Absolute path of the staged file on the Bridge host. */
	path: string;
	/** The content hash it was stored under (lower-case hex). */
	content_hash: string;
	/** Bytes on disk. */
	size: number;
	/** True when the Bridge reused an already-staged file (no upload). */
	reused: boolean;
}

/** Minimal shape this helper needs from an editor MediaAsset (a browser Blob + a name). */
export interface BlobAssetLike {
	/** The in-memory file/blob with no disk path. */
	file: Blob & { name?: string };
	/** Optional display name (used to derive a file extension on the Bridge). */
	name?: string;
}

/** SHA-256 of a Blob → lower-case hex, via the Web Crypto SubtleCrypto API. */
async function sha256Hex(blob: Blob): Promise<string> {
	const buf = await blob.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", buf);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

function normaliseBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/** Map a non-OK Response into the shared Bridge error types (after errorDetail). */
async function errorDetail(res: Response): Promise<string> {
	try {
		const j = (await res.json()) as { detail?: string };
		return j?.detail ?? `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	what: string,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} catch (err) {
		throw new BridgeUnavailableError(
			`Fadi Bridge unreachable (${what}): ${(err as Error)?.message ?? err}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe whether a hash is already staged on disk. Returns the StagedAsset (reused=true)
 * or null when absent. Network/5xx → throws (retried internally) so the caller can decide
 * to fall back; a clean 404 is the "not staged yet" signal and returns null.
 */
async function probeStaged(
	cfg: StageBlobConfig,
	contentHash: string,
): Promise<StagedAsset | null> {
	const base = normaliseBaseUrl(cfg.baseUrl);
	const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const path = `/assets/stage/${encodeURIComponent(contentHash)}`;
	return withRetry(async () => {
		const res = await fetchWithTimeout(
			`${base}${path}`,
			{ method: "GET", headers: { Authorization: `Bearer ${cfg.token}` } },
			timeoutMs,
			`GET ${path}`,
		);
		if (res.ok) return (await res.json()) as StagedAsset;
		if (res.status === 404) return null; // not staged yet — expected
		const detail = await errorDetail(res);
		throw new BridgeRequestError(res.status, detail);
	}).catch((err) => {
		if (err instanceof BridgeRequestError && err.status >= 500) {
			throw new BridgeUnavailableError(err.message);
		}
		throw err;
	});
}

/** Upload the bytes (multipart) under the given hash; returns the staged path. */
async function uploadStaged(
	cfg: StageBlobConfig,
	blob: Blob,
	contentHash: string,
	filename?: string,
): Promise<StagedAsset> {
	const base = normaliseBaseUrl(cfg.baseUrl);
	const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return withRetry(async () => {
		// Build a fresh FormData per attempt (a Blob body can't be replayed reliably).
		const form = new FormData();
		form.append("content_hash", contentHash);
		if (filename) form.append("filename", filename);
		if (blob.type) form.append("content_type", blob.type);
		form.append("file", blob, filename ?? "blob");
		const res = await fetchWithTimeout(
			`${base}/assets/stage`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${cfg.token}` },
				body: form,
			},
			timeoutMs,
			"POST /assets/stage",
		);
		if (res.ok) return (await res.json()) as StagedAsset;
		const detail = await errorDetail(res);
		throw new BridgeRequestError(res.status, detail);
	}).catch((err) => {
		if (err instanceof BridgeRequestError && err.status >= 500) {
			throw new BridgeUnavailableError(err.message);
		}
		throw err;
	});
}

/**
 * Stage a raw Blob: hash → probe → upload-if-needed. Lowest-level entry point.
 * `filename` is only a hint the Bridge uses to pick a file extension.
 */
export async function stageBlob(
	cfg: StageBlobConfig,
	blob: Blob,
	filename?: string,
): Promise<StagedAsset> {
	const contentHash = await sha256Hex(blob);
	const existing = await probeStaged(cfg, contentHash);
	if (existing) return existing;
	return uploadStaged(cfg, blob, contentHash, filename);
}

/** Stage a browser File (carries its own `.name` for the extension hint). */
export async function stageBlobFile(
	cfg: StageBlobConfig,
	file: File,
): Promise<StagedAsset> {
	return stageBlob(cfg, file, file.name);
}

/**
 * Stage an editor MediaAsset whose source is an in-memory Blob with no disk path.
 * Returns the absolute staged path the EDL/orchestrator can reference.
 */
export async function stageBlobAsset(
	cfg: StageBlobConfig,
	asset: BlobAssetLike,
): Promise<string> {
	const file = asset.file;
	const filename = asset.name ?? (file as { name?: string }).name;
	const staged = await stageBlob(cfg, file, filename);
	return staged.path;
}

/**
 * Build a staging config from NEXT_PUBLIC_ env (mirrors createBridgeClientFromEnv).
 * Returns null when no base URL is configured so callers can skip staging cleanly.
 */
export function createStageConfigFromEnv(): StageBlobConfig | null {
	const baseUrl =
		process.env.NEXT_PUBLIC_FADI_BRIDGE_URL?.trim() || "http://127.0.0.1:8765";
	const token = process.env.NEXT_PUBLIC_FADI_BRIDGE_TOKEN?.trim() ?? "";
	if (!baseUrl) return null;
	return { baseUrl, token };
}
