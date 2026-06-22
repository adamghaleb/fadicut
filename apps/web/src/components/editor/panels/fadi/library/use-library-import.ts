/**
 * Import bridge → editor for the Fadi asset library (Batch E).
 *
 * A catalog asset lives on the Bridge (possibly on the Seagate drive), not in the
 * project. To use one on the timeline it must first become a project `MediaAsset`
 * with a real `mediaId`. This hook does exactly that and nothing more — it reuses the
 * editor's *existing* import pipeline rather than reimplementing element creation:
 *
 *   Bridge range-media  →  File  →  processMediaAssets  →  editor.media.addMediaAsset
 *
 * The returned `MediaAsset` then flows through the same `DraggableItem` /
 * `buildElementFromMedia` path the native Media panel uses, so timeline drops, ripple,
 * masking, FPS-ratchet, undo/redo, and persistence all behave identically.
 *
 * Imports are memoized per asset path for the session so re-adding the same loop
 * doesn't re-download or duplicate the media row.
 */

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import type { MediaAsset } from "@/media/types";
import { processMediaAssets } from "@/media/processing";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { getLibraryClient } from "./library-client";
import type { CatalogAsset } from "./types";

export function useLibraryImport() {
	const editor = useEditor();
	// path → already-imported project media id (session cache)
	const importedCache = useRef<Map<string, string>>(new Map());
	const inFlight = useRef<Map<string, Promise<MediaAsset | null>>>(new Map());

	const importAsset = useCallback(
		async (asset: CatalogAsset): Promise<MediaAsset | null> => {
			const activeProject = editor.project.getActive();
			if (!activeProject) {
				toast.error("No active project");
				return null;
			}
			if (asset.missing) {
				toast.error(`"${asset.name}" is offline (drive unplugged)`);
				return null;
			}

			// Already imported this session → return the existing project asset.
			const cachedId = importedCache.current.get(asset.path);
			if (cachedId) {
				const existing = editor.media
					.getAssets()
					.find((a) => a.id === cachedId);
				if (existing) return existing;
			}

			// Coalesce concurrent imports of the same file.
			const pending = inFlight.current.get(asset.path);
			if (pending) return pending;

			const task = (async (): Promise<MediaAsset | null> => {
				try {
					const client = getLibraryClient();
					const file = await client.fetchAsFile(asset);
					const [processed] = await processMediaAssets({ files: [file] });
					if (!processed) {
						toast.error(`Could not import "${asset.name}"`);
						return null;
					}
					const mediaAsset = await editor.media.addMediaAsset({
						projectId: activeProject.metadata.id,
						asset: processed,
					});
					if (mediaAsset) importedCache.current.set(asset.path, mediaAsset.id);
					return mediaAsset;
				} catch (err) {
					toast.error(
						`Import failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					return null;
				} finally {
					inFlight.current.delete(asset.path);
				}
			})();

			inFlight.current.set(asset.path, task);
			return task;
		},
		[editor],
	);

	/** Import then insert at the playhead — used by the item's "+" / double-click. */
	const addToTimeline = useCallback(
		async (asset: CatalogAsset) => {
			const media = await importAsset(asset);
			if (!media) return;
			const startTime = editor.playback.getCurrentTime();
			const duration =
				media.duration != null
					? mediaTimeFromSeconds({ seconds: media.duration })
					: DEFAULT_NEW_ELEMENT_DURATION;
			const element = buildElementFromMedia({
				mediaId: media.id,
				mediaType: media.type,
				name: media.name,
				duration,
				startTime,
			});
			editor.timeline.insertElement({ element, placement: { mode: "auto" } });
		},
		[editor, importAsset],
	);

	const isImported = useCallback(
		(asset: CatalogAsset) => importedCache.current.has(asset.path),
		[],
	);

	return { importAsset, addToTimeline, isImported };
}
