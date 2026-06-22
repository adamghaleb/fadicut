/**
 * Typed Fadi Bridge client for beat detection (Batch C slice — scoped to the beatgrid module).
 *
 * Calls the Bridge's POST /beatgrid/detect (synchronous) endpoint, which wraps
 * snippet-selector/analyze_beats.py and fills SongContext.tempo (beat_grid + downbeats,
 * seconds). Mirrors the lyrics panel's client conventions (base URL, bearer token,
 * fetch-with-retry). Self-contained — does NOT touch any shared API layer.
 *
 * For long files / batch detection use the async variant (POST /beatgrid/detect/async)
 * + the shared /jobs/{id}/events SSE stream; that handle shape matches the lyrics
 * client's JobView, so the integrator can reuse subscribeJobProgress there.
 */

import type {
	ContractSection,
	ContractTempo,
	SongContextSlice,
} from "./contract-types";

export interface BridgeConfig {
	/** Base URL of the local Fadi Bridge. */
	baseUrl?: string;
	/** Shared bearer token (FADI_BRIDGE_TOKEN). */
	token?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

export interface DetectBeatsRequest {
	/** Absolute path to audio. Required unless songContext.audio.master_path is set. */
	audioPath?: string;
	/** A serialized SongContext (full contract) to fill — returned with tempo populated. */
	songContext?: Record<string, unknown>;
	/** Also return placeholder sections derived from downbeats. */
	deriveSections?: boolean;
	/** Section block size (bars) when deriveSections. */
	barsPerSection?: number;
}

export interface DetectBeatsResponse {
	tempo: ContractTempo;
	sections?: ContractSection[] | null;
	/** Present only when songContext was supplied — the same context with tempo filled. */
	song_context?: Record<string, unknown> | null;
}

/** The async-enqueue handle shape (matches the shared jobs JobView). */
export interface JobView {
	id: string;
	kind: string;
	lane: "gpu" | "cpu" | "io";
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	progress: number;
	message: string;
	result: DetectBeatsResponse | null;
	error: string | null;
}

function resolveConfig(config?: BridgeConfig): Required<BridgeConfig> {
	return {
		baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL,
		token: config?.token ?? "",
	};
}

function authHeaders(token: string): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch with retry + exponential backoff (1s → 2s → 4s, jittered). Retries on network
 * errors and 5xx; never retries 4xx. Mirrors the project retry policy.
 */
async function fetchWithRetry(
	input: string,
	init: RequestInit,
	{
		retries = 3,
		baseDelayMs = 1000,
	}: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(input, init);
			if (res.ok || (res.status >= 400 && res.status < 500)) {
				return res;
			}
			lastErr = new Error(`bridge ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
		}
		if (attempt < retries) {
			const delay = baseDelayMs * 2 ** attempt;
			const jitter = Math.random() * baseDelayMs;
			await new Promise((r) => setTimeout(r, delay + jitter));
		}
	}
	throw lastErr ?? new Error("bridge request failed");
}

function toBody(req: DetectBeatsRequest): Record<string, unknown> {
	return {
		audio_path: req.audioPath,
		song_context: req.songContext,
		derive_sections: req.deriveSections ?? false,
		bars_per_section: req.barsPerSection ?? 8,
	};
}

/**
 * Detect a song's beat grid synchronously. Returns the contract `Tempo` (+ optional
 * sections + filled song_context). Use for a single song the editor needs right now.
 */
export async function detectBeats({
	request,
	config,
}: {
	request: DetectBeatsRequest;
	config?: BridgeConfig;
}): Promise<DetectBeatsResponse> {
	const { baseUrl, token } = resolveConfig(config);
	const res = await fetchWithRetry(`${baseUrl}/beatgrid/detect`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(token) },
		body: JSON.stringify(toBody(request)),
	});
	if (!res.ok) {
		throw new Error(`detectBeats failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as DetectBeatsResponse;
}

/**
 * Enqueue beat detection as a job (POST /beatgrid/detect/async). Follow progress via the
 * shared GET /jobs/{id}/events SSE endpoint. Use for long files / batch runs.
 */
export async function detectBeatsAsync({
	request,
	config,
}: {
	request: DetectBeatsRequest;
	config?: BridgeConfig;
}): Promise<JobView> {
	const { baseUrl, token } = resolveConfig(config);
	const res = await fetchWithRetry(`${baseUrl}/beatgrid/detect/async`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(token) },
		body: JSON.stringify(toBody(request)),
	});
	if (!res.ok) {
		throw new Error(
			`detectBeatsAsync failed: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as JobView;
}

/** Convenience: detect beats and return a `SongContextSlice` ready for the snap/bookmark helpers. */
export async function detectBeatsAsSlice({
	songId,
	audioPath,
	deriveSections = true,
	config,
}: {
	songId: string;
	audioPath: string;
	deriveSections?: boolean;
	config?: BridgeConfig;
}): Promise<SongContextSlice> {
	const resp = await detectBeats({
		request: { audioPath, deriveSections },
		config,
	});
	return {
		song_id: songId,
		tempo: resp.tempo,
		sections: resp.sections ?? undefined,
	};
}
