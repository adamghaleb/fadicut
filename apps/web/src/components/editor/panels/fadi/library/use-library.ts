/**
 * Data hooks for the Fadi asset library panel (Batch E).
 *
 * `useLibrary(filters)` — debounced search against the Bridge catalog with a clear
 * connection state (`online` / `offline` / `loading`). It never throws into render;
 * a Bridge or Seagate-drive outage resolves to `status: "offline"` so the panel can
 * show a graceful empty state instead of crashing.
 *
 * `useLibraryRoots()` — per-root online status (which packs are reachable) so the UI
 * can flag offline roots (drive unplugged) and offer a reindex.
 *
 * Both are local to this panel per scope discipline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLibraryClient } from "./library-client";
import type { AssetFilters, CatalogAsset, RootStatus, TagCount } from "./types";

export type ConnState = "loading" | "online" | "offline";

interface UseLibraryResult {
	assets: CatalogAsset[];
	total: number;
	status: ConnState;
	error: string | null;
	refresh: () => void;
}

const DEBOUNCE_MS = 250;

export function useLibrary(
	filters: AssetFilters,
	{ limit = 200 }: { limit?: number } = {},
): UseLibraryResult {
	const [assets, setAssets] = useState<CatalogAsset[]>([]);
	const [total, setTotal] = useState(0);
	const [status, setStatus] = useState<ConnState>("loading");
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);

	const filtersKey = JSON.stringify(filters);

	useEffect(() => {
		const client = getLibraryClient();
		const controller = new AbortController();
		setStatus((s) => (s === "online" ? "online" : "loading"));

		const handle = setTimeout(async () => {
			try {
				const res = await client.search(JSON.parse(filtersKey), {
					limit,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setAssets(res.items);
				setTotal(res.total);
				setStatus("online");
				setError(null);
			} catch (err) {
				if ((err as Error)?.name === "AbortError") return;
				// Bridge unreachable or drive offline — degrade gracefully.
				setStatus("offline");
				setError(err instanceof Error ? err.message : String(err));
			}
		}, DEBOUNCE_MS);

		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [filtersKey, limit, nonce]);

	const refresh = useCallback(() => setNonce((n) => n + 1), []);

	return { assets, total, status, error, refresh };
}

interface UseLibraryRootsResult {
	roots: RootStatus[];
	tags: TagCount[];
	watcherBackend: string;
	totalIndexed: number;
	status: ConnState;
	refresh: () => void;
}

export function useLibraryRoots(): UseLibraryRootsResult {
	const [roots, setRoots] = useState<RootStatus[]>([]);
	const [tags, setTags] = useState<TagCount[]>([]);
	const [watcherBackend, setWatcherBackend] = useState("");
	const [totalIndexed, setTotalIndexed] = useState(0);
	const [status, setStatus] = useState<ConnState>("loading");
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		const client = getLibraryClient();
		const controller = new AbortController();
		(async () => {
			try {
				const [r, t] = await Promise.all([
					client.roots(controller.signal),
					client.tags(controller.signal).catch(() => [] as TagCount[]),
				]);
				if (controller.signal.aborted) return;
				setRoots(r.roots);
				setWatcherBackend(r.watcher_backend);
				setTotalIndexed(r.total_indexed);
				setTags(t);
				setStatus("online");
			} catch (err) {
				if ((err as Error)?.name === "AbortError") return;
				setStatus("offline");
			}
		})();
		return () => controller.abort();
	}, [nonce]);

	const refresh = useCallback(() => setNonce((n) => n + 1), []);

	return { roots, tags, watcherBackend, totalIndexed, status, refresh };
}
