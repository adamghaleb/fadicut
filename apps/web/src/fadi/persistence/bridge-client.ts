/**
 * Typed client for the Fadi Bridge project-persistence API (batch G, issue #7).
 *
 * Wraps the Bridge's /projects endpoints behind a small typed surface the editor can use
 * INSTEAD OF IndexedDB. It does not replace IndexedDB — it sits alongside it (see
 * project-persistence.ts for the autosave/recovery layer that ties them together).
 *
 * Every request:
 *   • sends the bearer token (Authorization header)
 *   • has a timeout (AbortController)
 *   • is wrapped in exponential-backoff retry (5xx + network only; never 4xx)
 *
 * Error mapping:
 *   • 409                → ProjectConflictError   (rev moved under us — surface a merge/overwrite prompt)
 *   • network / 5xx-out  → BridgeUnavailableError (drive offline or Bridge down — fall back to IndexedDB)
 *   • other 4xx          → BridgeRequestError
 */

import { withRetry } from "./retry";
import {
	BridgeClientConfig,
	BridgeRequestError,
	BridgeUnavailableError,
	LoadResult,
	ProjectConflictError,
	ProjectDoc,
	ProjectListing,
	ProjectRootInfo,
	RecoveryInfo,
	SaveResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

export class FadiBridgeClient {
	private baseUrl: string;
	private token: string;
	private timeoutMs: number;

	constructor(cfg: BridgeClientConfig) {
		this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
		this.token = cfg.token;
		this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		return withRetry(async () => {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
			let res: Response;
			try {
				res = await fetch(`${this.baseUrl}${path}`, {
					method,
					headers: {
						Authorization: `Bearer ${this.token}`,
						...(body !== undefined
							? { "Content-Type": "application/json" }
							: {}),
					},
					body: body !== undefined ? JSON.stringify(body) : undefined,
					signal: ctrl.signal,
				});
			} catch (err) {
				// network failure / abort → no status → retryable; final throw becomes BridgeUnavailable
				throw new BridgeUnavailableError(
					`Fadi Bridge unreachable (${method} ${path}): ${(err as Error)?.message ?? err}`,
				);
			} finally {
				clearTimeout(timer);
			}

			if (res.ok) {
				// 200/201 — parse JSON (DELETE returns a small object too)
				return (await res.json()) as T;
			}

			const detail = await this.errorDetail(res);
			if (res.status === 409) throw new ProjectConflictError(detail);
			// 5xx is thrown WITH a status so withRetry's default predicate retries it; if
			// retries are exhausted the thrown error surfaces — remap to BridgeUnavailable.
			if (res.status >= 500) throw new BridgeRequestError(res.status, detail);
			throw new BridgeRequestError(res.status, detail);
		}).catch((err) => {
			// after retries: a 5xx BridgeRequestError means the Bridge is effectively down
			if (err instanceof BridgeRequestError && err.status >= 500) {
				throw new BridgeUnavailableError(err.message);
			}
			throw err;
		});
	}

	private async errorDetail(res: Response): Promise<string> {
		try {
			const j = (await res.json()) as { detail?: string };
			return j?.detail ?? `HTTP ${res.status}`;
		} catch {
			return `HTTP ${res.status}`;
		}
	}

	// ── API ──────────────────────────────────────────────────────────────────

	/** Liveness + which root (drive vs fallback) projects are landing in right now. */
	async getRoot(): Promise<ProjectRootInfo> {
		return this.request<ProjectRootInfo>("GET", "/projects/root");
	}

	async listProjects(): Promise<ProjectListing[]> {
		return this.request<ProjectListing[]>("GET", "/projects");
	}

	async loadProject(projectId: string): Promise<LoadResult> {
		return this.request<LoadResult>(
			"GET",
			`/projects/${encodeURIComponent(projectId)}`,
		);
	}

	/**
	 * Save a project. Pass `expectedRev` (the rev you loaded) to get optimistic-concurrency
	 * protection — a mismatch throws ProjectConflictError instead of clobbering another
	 * session's edit. Omit it for a forced/initial save.
	 */
	async saveProject(
		doc: ProjectDoc,
		expectedRev?: number,
	): Promise<SaveResult> {
		return this.request<SaveResult>(
			"POST",
			`/projects/${encodeURIComponent(doc.meta.project_id)}`,
			{ doc, expected_rev: expectedRev ?? null },
		);
	}

	async getRecoveryInfo(projectId: string): Promise<RecoveryInfo> {
		return this.request<RecoveryInfo>(
			"GET",
			`/projects/${encodeURIComponent(projectId)}/recovery`,
		);
	}

	async deleteProject(projectId: string): Promise<{ deleted: string }> {
		return this.request<{ deleted: string }>(
			"DELETE",
			`/projects/${encodeURIComponent(projectId)}`,
		);
	}

	/** Cheap reachability probe — used by the autosave layer to decide drive vs IndexedDB. */
	async isAvailable(): Promise<boolean> {
		try {
			await this.getRoot();
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Build a client from NEXT_PUBLIC_ env (kept optional so the editor still boots without
 * the Bridge configured). Returns null when no base URL is set, so callers fall back to
 * IndexedDB cleanly.
 */
export function createBridgeClientFromEnv(): FadiBridgeClient | null {
	const baseUrl =
		process.env.NEXT_PUBLIC_FADI_BRIDGE_URL?.trim() || "http://127.0.0.1:8765";
	const token = process.env.NEXT_PUBLIC_FADI_BRIDGE_TOKEN?.trim() ?? "";
	if (!baseUrl) return null;
	return new FadiBridgeClient({ baseUrl, token });
}
