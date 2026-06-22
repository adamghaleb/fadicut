/**
 * Small retry-with-exponential-backoff helper, scoped to the Fadi persistence client.
 *
 * Project rule: every HTTP request gets retry with exponential backoff + jitter —
 * 3 retries, 1s → 2s → 4s, retry on 5xx + network errors, never on 4xx.
 *
 * This lives in batch G's own scope so it doesn't edit any shared util. If a project-wide
 * retry helper later appears, re-export from it and delete this file.
 */

export interface RetryOptions {
	retries?: number; // attempts AFTER the first try (default 3)
	baseDelayMs?: number; // first backoff (default 1000)
	/** Return true to retry. Default: network errors + 5xx. */
	shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/** Marker for HTTP errors so the default predicate can inspect the status. */
export interface HasStatus {
	status?: number;
}

function defaultShouldRetry(err: unknown): boolean {
	const status = (err as HasStatus | undefined)?.status;
	if (typeof status === "number") {
		// retry transient server errors only; never 4xx
		return status === 500 || status === 502 || status === 503 || status === 504;
	}
	// no status → network/abort/DNS failure → retry
	return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: RetryOptions = {},
): Promise<T> {
	const retries = opts.retries ?? 3;
	const base = opts.baseDelayMs ?? 1000;
	const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt === retries || !shouldRetry(err, attempt)) break;
			// exponential backoff with full jitter: 1s, 2s, 4s (± jitter)
			const ceiling = base * 2 ** attempt;
			const delay = Math.random() * ceiling;
			await sleep(delay);
		}
	}
	throw lastErr;
}
