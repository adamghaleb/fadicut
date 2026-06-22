/**
 * Typed Fadi Bridge client (Batch B slice — scoped to the lyric panel).
 *
 * The Bridge (FastAPI, localhost) owns the native tools. This is the *one* typed
 * call the lyric panel needs: enqueue a `render_lyric` job (meandu engine) and
 * follow its SSE progress to a transparent lyric .mov path.
 *
 * Scope discipline: this is a self-contained client local to the lyrics panel — it
 * does NOT touch any shared/global API layer. A later integrator can promote it to a
 * shared bridge SDK; until then the panel owns its own thin client.
 *
 * Contract alignment: the job payload mirrors a FadiEDL LyricEffect slice
 * (contracts/fadi_edl.py LyricEffect + element start/duration). Times are seconds.
 */

export interface BridgeConfig {
	/** Base URL of the local Fadi Bridge. */
	baseUrl?: string;
	/** Shared bearer token (FADI_BRIDGE_TOKEN). */
	token?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

/** Payload for a `render_lyric` job — a slice of a FadiEDL lyric element. */
export interface MeanduLyricJobPayload {
	song_id: string;
	/** Timeline position of the lyric element, seconds. */
	start_sec: number;
	/** Element duration, seconds. */
	duration_sec: number;
	/** LyricEffect.fill_mode passthrough hint. */
	fill_mode?: "white" | "black" | "strobe" | "tri_zone";
	/** Optional absolute output path for the .mov; Bridge picks a temp path if omitted. */
	out_path?: string;
	/** Render only the first N frames (fast spike / preview bakes). */
	smoke_frames?: number;
}

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface JobView {
	id: string;
	kind: string;
	lane: "gpu" | "cpu" | "io";
	status: JobStatus;
	progress: number;
	message: string;
	result: MeanduLyricResult | null;
	error: string | null;
}

/** Result dict the meandu adapter returns on success. */
export interface MeanduLyricResult {
	ok: boolean;
	out_path: string;
	width: number;
	height: number;
	fps: number;
	start_sec: number;
	duration_sec: number;
	engine: "meandu";
	transparent: boolean;
}

export interface ProgressEvent {
	job_id: string;
	status: JobStatus;
	progress: number;
	message: string;
	result: MeanduLyricResult | null;
	error: string | null;
	ts: number;
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
 * fetch with retry + exponential backoff (1s → 2s → 4s, jittered). Retries on
 * network errors and 5xx; never retries 4xx. Mirrors the project retry policy.
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

/** Enqueue a meandu lyric bake. Returns the created job. */
export async function submitLyricBake({
	payload,
	config,
}: {
	payload: MeanduLyricJobPayload;
	config?: BridgeConfig;
}): Promise<JobView> {
	const { baseUrl, token } = resolveConfig(config);
	const res = await fetchWithRetry(`${baseUrl}/jobs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...authHeaders(token),
		},
		body: JSON.stringify({
			kind: "render_lyric",
			lane: "cpu",
			name: `lyric:${payload.song_id}`,
			payload,
		}),
	});
	if (!res.ok) {
		throw new Error(
			`submitLyricBake failed: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as JobView;
}

/** Fetch the current state of a job (one-shot poll). */
export async function getJob({
	jobId,
	config,
}: {
	jobId: string;
	config?: BridgeConfig;
}): Promise<JobView> {
	const { baseUrl, token } = resolveConfig(config);
	const res = await fetchWithRetry(`${baseUrl}/jobs/${jobId}`, {
		method: "GET",
		headers: authHeaders(token),
	});
	if (!res.ok) {
		throw new Error(`getJob failed: ${res.status}`);
	}
	return (await res.json()) as JobView;
}

/**
 * Subscribe to a job's SSE progress stream. The Bridge accepts the token as a
 * query param because EventSource can't set Authorization headers. Returns an
 * unsubscribe function. Resolves the terminal frame via onDone.
 */
export function subscribeJobProgress({
	jobId,
	config,
	onProgress,
	onDone,
	onError,
}: {
	jobId: string;
	config?: BridgeConfig;
	onProgress?: (evt: ProgressEvent) => void;
	onDone?: (evt: ProgressEvent) => void;
	onError?: (err: Error) => void;
}): () => void {
	const { baseUrl, token } = resolveConfig(config);
	const url = new URL(`${baseUrl}/jobs/${jobId}/events`);
	if (token) url.searchParams.set("token", token);

	const es = new EventSource(url.toString());

	es.addEventListener("progress", (e) => {
		try {
			const evt = JSON.parse((e as MessageEvent).data) as ProgressEvent;
			onProgress?.(evt);
			if (
				evt.status === "succeeded" ||
				evt.status === "failed" ||
				evt.status === "cancelled"
			) {
				onDone?.(evt);
				es.close();
			}
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)));
		}
	});

	es.onerror = () => {
		// EventSource auto-reconnects; surface only if the stream is closed.
		if (es.readyState === EventSource.CLOSED) {
			onError?.(new Error("bridge SSE connection closed"));
		}
	};

	return () => es.close();
}
