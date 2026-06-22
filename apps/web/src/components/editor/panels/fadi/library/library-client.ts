/**
 * Typed client for the Fadi Bridge asset catalog (Batch E).
 *
 * Wraps the `/assets` REST surface (assets/api.py): search/filter, tags, roots,
 * proxy build + stream URLs, range-media URLs, and reindex. Self-contained and local
 * to this panel per scope discipline — it does not touch any shared API layer.
 *
 * Config comes from NEXT_PUBLIC_FADI_BRIDGE_URL / NEXT_PUBLIC_FADI_BRIDGE_TOKEN
 * (same convention as the lyrics + persistence bridge clients), defaulting to
 * http://127.0.0.1:8765 so the editor still boots with no env set.
 *
 * Graceful degradation: every network call retries with exponential backoff, and the
 * higher-level hooks treat a thrown error as "Bridge / drive offline" rather than a
 * hard failure — the panel shows an offline state instead of crashing.
 */

import type {
	AssetFilters,
	CatalogAsset,
	RootsResponse,
	SearchResponse,
	TagCount,
} from "./types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

export interface LibraryConfig {
	baseUrl: string;
	token: string;
}

export function resolveLibraryConfig(): LibraryConfig {
	const baseUrl = (
		process.env.NEXT_PUBLIC_FADI_BRIDGE_URL?.trim() || DEFAULT_BASE_URL
	).replace(/\/+$/, "");
	const token = process.env.NEXT_PUBLIC_FADI_BRIDGE_TOKEN?.trim() ?? "";
	return { baseUrl, token };
}

function authHeaders(token: string): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch with retry + exponential backoff (1s → 2s → 4s, jittered). Retries on
 * network errors and 5xx; never retries 4xx. Matches the project retry policy.
 */
async function fetchWithRetry(
	input: string,
	init: RequestInit,
	{
		retries = 3,
		baseDelayMs = 1000,
		signal,
	}: { retries?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");
		try {
			const res = await fetch(input, { ...init, signal });
			if (res.ok || (res.status >= 400 && res.status < 500)) return res;
			lastErr = new Error(`bridge ${res.status} ${res.statusText}`);
		} catch (err) {
			if ((err as Error)?.name === "AbortError") throw err;
			lastErr = err;
		}
		if (attempt < retries) {
			const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw lastErr ?? new Error("bridge request failed");
}

export class LibraryClient {
	private baseUrl: string;
	private token: string;

	constructor(config?: Partial<LibraryConfig>) {
		const resolved = resolveLibraryConfig();
		this.baseUrl = (config?.baseUrl ?? resolved.baseUrl).replace(/\/+$/, "");
		this.token = config?.token ?? resolved.token;
	}

	private async json<T>(
		path: string,
		init: RequestInit,
		signal?: AbortSignal,
	): Promise<T> {
		const res = await fetchWithRetry(
			`${this.baseUrl}${path}`,
			{
				...init,
				headers: { ...authHeaders(this.token), ...(init.headers ?? {}) },
			},
			{ signal },
		);
		if (!res.ok) {
			throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
		}
		return (await res.json()) as T;
	}

	/** Liveness probe — used to detect whether the Bridge is reachable at all. */
	async ping(signal?: AbortSignal): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, { signal });
			return res.ok;
		} catch {
			return false;
		}
	}

	async search(
		filters: AssetFilters,
		{
			limit = 120,
			offset = 0,
			signal,
		}: { limit?: number; offset?: number; signal?: AbortSignal } = {},
	): Promise<SearchResponse> {
		const qs = new URLSearchParams();
		if (filters.q) qs.set("q", filters.q);
		if (filters.kind) qs.set("kind", filters.kind);
		if (filters.kind_hint) qs.set("kind_hint", filters.kind_hint);
		if (filters.has_alpha != null)
			qs.set("has_alpha", String(filters.has_alpha));
		if (filters.root_label) qs.set("root_label", filters.root_label);
		if (filters.sort) qs.set("sort", filters.sort);
		if (filters.order) qs.set("order", filters.order);
		for (const t of filters.tags ?? []) qs.append("tag", t);
		qs.set("limit", String(limit));
		qs.set("offset", String(offset));
		return this.json<SearchResponse>(
			`/assets?${qs}`,
			{ method: "GET" },
			signal,
		);
	}

	async roots(signal?: AbortSignal): Promise<RootsResponse> {
		return this.json<RootsResponse>("/assets/roots", { method: "GET" }, signal);
	}

	async tags(signal?: AbortSignal): Promise<TagCount[]> {
		const r = await this.json<{ tags: TagCount[] }>(
			"/assets/tags",
			{ method: "GET" },
			signal,
		);
		return r.tags;
	}

	async mutateTags(
		op: "set" | "add" | "remove",
		path: string,
		tags: string[],
	): Promise<CatalogAsset> {
		return this.json<CatalogAsset>(`/assets/${op}/tags`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, tags }),
		});
	}

	async reindex(force = false): Promise<void> {
		await this.json(`/assets/reindex?force=${force}`, { method: "POST" });
	}

	// ── URL builders for <video>/<img> (token via query — headers can't be set) ──

	/** Range-media URL for the original file (assets/media.py / batch A). */
	mediaUrl(asset: Pick<CatalogAsset, "path">): string {
		const u = new URL(`${this.baseUrl}/media`);
		u.searchParams.set("path", asset.path);
		if (this.token) u.searchParams.set("token", this.token);
		return u.toString();
	}

	/** Proxy stream URL (lighter preview; falls back to mediaUrl if no proxy). */
	proxyUrl(asset: Pick<CatalogAsset, "content_hash" | "kind">): string {
		const u = new URL(`${this.baseUrl}/assets/proxy`);
		u.searchParams.set("hash", asset.content_hash);
		u.searchParams.set("kind", asset.kind);
		if (this.token) u.searchParams.set("token", this.token);
		return u.toString();
	}

	/** POST to build a proxy (path is a query param per the API). */
	async ensureProxy(path: string): Promise<boolean> {
		try {
			const u = new URL(`${this.baseUrl}/assets/proxy`);
			u.searchParams.set("path", path);
			const res = await fetchWithRetry(u.toString(), {
				method: "POST",
				headers: authHeaders(this.token),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Fetch a catalog asset's *original* bytes as a browser File, so it can flow
	 * through the editor's normal import pipeline (processMediaAssets →
	 * addMediaAsset). Streams via the range-media endpoint.
	 */
	async fetchAsFile(asset: CatalogAsset): Promise<File> {
		const res = await fetchWithRetry(this.mediaUrl(asset), { method: "GET" });
		if (!res.ok) throw new Error(`fetch media failed: ${res.status}`);
		const blob = await res.blob();
		const type = blob.type || guessMime(asset);
		return new File([blob], asset.name, { type });
	}
}

function guessMime(asset: CatalogAsset): string {
	if (asset.kind === "video") return "video/mp4";
	if (asset.kind === "image") return "image/png";
	if (asset.kind === "audio") return "audio/wav";
	return "application/octet-stream";
}

let _singleton: LibraryClient | null = null;
export function getLibraryClient(): LibraryClient {
	if (!_singleton) _singleton = new LibraryClient();
	return _singleton;
}
