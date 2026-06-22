/**
 * Typed Fadi Bridge client for the native export-bake orchestration (issue #4).
 *
 * Mirrors the lyrics-panel bridge client pattern: a self-contained thin client that
 * POSTs a FadiEDL to the Bridge `/render` endpoint (enqueues a `render_project` job on
 * the cpu lane), then follows the job's SSE progress to a final composited mp4 path.
 *
 * Env: NEXT_PUBLIC_FADI_BRIDGE_URL / NEXT_PUBLIC_FADI_BRIDGE_TOKEN (same as the other
 * Fadi clients). Times in the EDL are seconds (the frozen contract).
 */

export interface BridgeConfig {
	/** Base URL of the local Fadi Bridge. */
	baseUrl?: string;
	/** Shared bearer token (FADI_BRIDGE_TOKEN). */
	token?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

/** Result dict the orchestrator returns on success (render.orchestrator.render_edl). */
export interface RenderResult {
	ok: boolean;
	out_path: string;
	width: number;
	height: number;
	fps: number;
	duration_sec: number;
	baked: { grade: number; lyric: number };
	audio_muxed: boolean;
	engine: "orchestrator";
}

export interface JobView {
	id: string;
	kind: string;
	lane: "gpu" | "cpu" | "io";
	status: JobStatus;
	progress: number;
	message: string;
	result: RenderResult | null;
	error: string | null;
}

export interface ProgressEvent {
	job_id: string;
	status: JobStatus;
	progress: number;
	message: string;
	result: RenderResult | null;
	error: string | null;
	ts: number;
}

/** A FadiEDL is the frozen contract shape; the editor's edl-adapter builds it. We pass
 * it through as an opaque object so this client stays decoupled from the adapter type. */
export type FadiEDLPayload = Record<string, unknown>;

export interface RenderRequest {
	edl: FadiEDLPayload;
	out_path?: string;
	/** Lyric engine: render only the first N frames (fast preview bakes). */
	smoke_frames?: number;
	name?: string;
}

function resolveConfig(config?: BridgeConfig): Required<BridgeConfig> {
	return {
		baseUrl:
			config?.baseUrl ??
			process.env.NEXT_PUBLIC_FADI_BRIDGE_URL?.trim() ??
			DEFAULT_BASE_URL,
		token:
			config?.token ?? process.env.NEXT_PUBLIC_FADI_BRIDGE_TOKEN?.trim() ?? "",
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

/** Enqueue a native render-project orchestration. Returns the created job. */
export async function submitRender({
	request,
	config,
}: {
	request: RenderRequest;
	config?: BridgeConfig;
}): Promise<JobView> {
	const { baseUrl, token } = resolveConfig(config);
	const res = await fetchWithRetry(`${baseUrl}/render`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...authHeaders(token),
		},
		body: JSON.stringify(request),
	});
	if (!res.ok) {
		throw new Error(`submitRender failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as JobView;
}

/**
 * Subscribe to a job's SSE progress stream. The Bridge accepts the token as a query
 * param because EventSource can't set Authorization headers. Returns an unsubscribe fn.
 */
export function subscribeRenderProgress({
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
		if (es.readyState === EventSource.CLOSED) {
			onError?.(new Error("bridge SSE connection closed"));
		}
	};

	return () => es.close();
}

/** Range-media URL for streaming/downloading a Bridge-side output file (assets/media.py). */
export function bridgeMediaUrl({
	path,
	config,
}: {
	path: string;
	config?: BridgeConfig;
}): string {
	const { baseUrl, token } = resolveConfig(config);
	const u = new URL(`${baseUrl}/media`);
	u.searchParams.set("path", path);
	if (token) u.searchParams.set("token", token);
	return u.toString();
}
