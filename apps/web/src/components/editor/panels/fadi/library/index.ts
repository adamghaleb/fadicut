/**
 * Fadi asset-library panel (Batch E) — public surface for the integrator.
 *
 * Wire-up (in shared/registry files this batch does NOT touch):
 *   1. Add a "fadi" / "library" tab to assets-panel-store (TAB_KEYS + tabs map).
 *   2. In panels/assets/index.tsx viewMap, render `<LibraryPanel />` for that tab.
 *
 * Everything below the panel (Bridge client, hooks, item, filters, offline state) is
 * self-contained and reachable from here for tests or alternate mounts.
 */

export { LibraryPanel, default } from "./library-panel";
export {
	LibraryClient,
	getLibraryClient,
	resolveLibraryConfig,
} from "./library-client";
export { useLibrary, useLibraryRoots } from "./use-library";
export { useLibraryImport } from "./use-library-import";
export type {
	AssetFilters,
	AssetKind,
	AssetKindHint,
	CatalogAsset,
	RootStatus,
	RootsResponse,
	SearchResponse,
	TagCount,
} from "./types";
