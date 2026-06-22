/**
 * Types for the Fadi asset library panel (Batch E). Mirror the Bridge catalog rows
 * returned by `GET /assets` (assets/catalog.py → AssetCatalog.search). Kept local to
 * this panel per scope discipline; an integrator can promote to a shared SDK later.
 */

/** A media kind as probed by the Bridge (assets/probe.py). */
export type AssetKind = "video" | "image" | "audio" | "unknown";

/** The `kind` hint from asset_roots.toml — the root's default category. */
export type AssetKindHint =
	| "loop"
	| "overlay"
	| "clip"
	| "footage"
	| "mixed"
	| (string & {});

/** One catalog row. Matches AssetCatalog._row_to_dict. */
export interface CatalogAsset {
	path: string;
	root_label: string;
	content_hash: string;
	kind: AssetKind;
	codec: string | null;
	duration: number | null; // seconds; null for stills
	width: number | null;
	height: number | null;
	fps: number | null;
	has_alpha: boolean; // ProRes 4444 / PNG-alpha loops + overlays
	size: number; // bytes
	mtime: number;
	kind_hint: AssetKindHint;
	tags: string[];
	name: string;
	indexed_at: number;
	proxy_path: string | null;
	missing: boolean;
}

export interface SearchResponse {
	items: CatalogAsset[];
	total: number;
	limit: number;
	offset: number;
}

/** Per-root status from `GET /assets/roots`. */
export interface RootStatus {
	label: string;
	path: string;
	kind: AssetKindHint;
	recursive: boolean;
	online: boolean;
	removable: boolean;
	indexed_count: number;
}

export interface RootsResponse {
	roots: RootStatus[];
	watcher_backend: "watchdog" | "poll" | string;
	total_indexed: number;
}

export interface TagCount {
	tag: string;
	count: number;
}

/** Filters the panel UI binds to. All optional / additive. */
export interface AssetFilters {
	q?: string;
	kind?: AssetKind;
	kind_hint?: AssetKindHint;
	tags?: string[];
	has_alpha?: boolean;
	root_label?: string;
	sort?: "name" | "kind" | "duration" | "size" | "indexed_at";
	order?: "asc" | "desc";
}
