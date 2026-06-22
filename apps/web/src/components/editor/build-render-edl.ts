/**
 * Build a render-ready FadiEDL for the native export-bake path (issue #4).
 *
 * Starts from the structural EDL produced by the frozen adapter (`projectToEdl`), then
 * enriches it so the Bridge orchestrator can resolve media on disk and bind the song:
 *
 *   • main video/image elements get `params.src_path` — the absolute filesystem path the
 *     Bridge reads. We resolve it from the element's bound media asset when that asset
 *     carries a native path (Library/drive-imported assets whose `name` is an absolute
 *     path). Browser-only blob assets have no disk path and are left unresolved; the
 *     orchestrator surfaces a clear error for those (documented MVP cut — blob→disk
 *     staging is not in scope).
 *   • the EDL's `song_id` is set when the editor has a song bound, so the Bridge muxes
 *     the master audio and the meandu lyric engine has its source.
 *   • render width/height come from the project settings (the adapter only carries fps).
 *
 * Pure + total: never throws; returns the best EDL it can build.
 */

import { projectToEdl } from "@/fadi/persistence";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";

/** An asset's absolute disk path, if it has one. Library/drive assets import by absolute
 * path; pure browser blobs don't. We treat an absolute-looking `name` as the path. */
function assetDiskPath(asset: MediaAsset | undefined): string | undefined {
	if (!asset) return undefined;
	const candidate =
		(asset as unknown as { fadiPath?: string }).fadiPath ??
		(asset as unknown as { path?: string }).path ??
		asset.name;
	if (typeof candidate === "string" && /^[~/]/.test(candidate)) {
		return candidate;
	}
	return undefined;
}

export interface BuildRenderEdlInput {
	project: TProject;
	/** Media assets currently loaded for the project (editor.media.getAssets()). */
	assets: MediaAsset[];
	/** Render canvas width — from project settings. */
	width: number;
	/** Render canvas height — from project settings. */
	height: number;
	/** Song bound to the edit, if any (enables audio mux + lyric source). */
	songId?: string;
}

/** Count of main elements whose media we could resolve to a disk path. */
export interface BuildRenderEdlResult {
	edl: Record<string, unknown>;
	resolvedMedia: number;
	unresolvedMedia: number;
}

export function buildRenderEdl({
	project,
	assets,
	width,
	height,
	songId,
}: BuildRenderEdlInput): BuildRenderEdlResult {
	const edl = projectToEdl({ project }) as Record<string, unknown>;
	const assetById = new Map(assets.map((a) => [a.id, a]));

	// Set render canvas dims (the adapter only stamps fps).
	const render = (edl.render ?? {}) as Record<string, unknown>;
	render.width = width;
	render.height = height;
	edl.render = render;

	if (songId) edl.song_id = songId;

	let resolved = 0;
	let unresolved = 0;

	const tracks = (edl.tracks ?? []) as Array<Record<string, unknown>>;
	for (const track of tracks) {
		if (track.role !== "main") continue;
		const elements = (track.elements ?? []) as Array<Record<string, unknown>>;
		for (const el of elements) {
			if (el.type !== "video" && el.type !== "image") continue;
			const mediaId = String(el.media_id ?? "");
			const disk = assetDiskPath(assetById.get(mediaId));
			const params = (el.params ?? {}) as Record<string, unknown>;
			if (disk) {
				params.src_path = disk;
				el.params = params;
				resolved += 1;
			} else if (mediaId && /^[~/]/.test(mediaId)) {
				// media_id is itself an absolute path (e.g. a Library asset) — orchestrator
				// already honours that, but stamp it for clarity.
				params.src_path = mediaId;
				el.params = params;
				resolved += 1;
			} else {
				unresolved += 1;
			}
		}
	}

	return { edl, resolvedMedia: resolved, unresolvedMedia: unresolved };
}
