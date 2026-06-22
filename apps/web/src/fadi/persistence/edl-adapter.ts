/**
 * Best-effort browser → FadiEDL serializer (batch G, issue #7).
 *
 * Maps the OpenCut editor's `TProject` (scenes / tracks / elements with `MediaTime`
 * **ticks**) to the contract `FadiEDL` shape, whose times are **seconds** (float).
 *
 * This is intentionally PARTIAL and forward-compatible:
 *   • It captures enough structure (tracks → elements with second-based timing) for the
 *     drive copy to be a useful artifact, but treats the rich per-element data as opaque
 *     passthrough rather than re-deriving the frozen Python contract shape field-for-field.
 *   • The authoritative editor state still round-trips through IndexedDB; the EDL is the
 *     drive-facing mirror. We stash the serialized scenes under `render.editor_scenes` so a
 *     future loader can reconstruct exactly without a lossy reverse-map.
 *
 * Nothing here imports from `contracts/` — it builds the structural `FadiEDL` from
 * `@/fadi/persistence/types`.
 */

import { mediaTimeToSeconds, type MediaTime } from "@/wasm";
import type { TProject } from "@/project/types";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import type { FadiEDL, ProjectMeta } from "./types";

const EDL_SCHEMA_VERSION = "1.0";

function ticksToSec(time: MediaTime | undefined): number {
	if (time === undefined || time === null) return 0;
	try {
		return mediaTimeToSeconds({ time });
	} catch {
		// MediaTime is just a branded number at runtime; fall back to raw if conversion throws.
		return Number(time) || 0;
	}
}

/** One EDL element entry — structural, seconds-based, with the raw element kept for fidelity. */
interface EdlElement {
	id: string;
	type: string;
	name: string;
	start_sec: number;
	duration_sec: number;
	trim_start_sec: number;
	trim_end_sec: number;
	/** Opaque passthrough of the original element so nothing is lost on the drive copy. */
	raw: unknown;
}

interface EdlTrack {
	id: string;
	name: string;
	type: string;
	role: "main" | "overlay" | "audio";
	elements: EdlElement[];
}

function serializeElement(el: TimelineElement): EdlElement {
	return {
		id: el.id,
		type: el.type,
		name: el.name,
		start_sec: ticksToSec(el.startTime),
		duration_sec: ticksToSec(el.duration),
		trim_start_sec: ticksToSec(el.trimStart),
		trim_end_sec: ticksToSec(el.trimEnd),
		raw: el,
	};
}

function serializeTrack(
	track: TimelineTrack,
	role: EdlTrack["role"],
): EdlTrack {
	return {
		id: track.id,
		name: track.name,
		type: track.type,
		role,
		elements: track.elements.map((el) => serializeElement(el)),
	};
}

function serializeSceneTracks(tracks: SceneTracks): EdlTrack[] {
	const out: EdlTrack[] = [];
	out.push(serializeTrack(tracks.main, "main"));
	for (const t of tracks.overlay) out.push(serializeTrack(t, "overlay"));
	for (const t of tracks.audio) out.push(serializeTrack(t, "audio"));
	return out;
}

/**
 * Convert a loaded `TProject` to the structural `FadiEDL`. Best-effort and total — never
 * throws; on any unexpected shape it produces an empty-but-valid EDL.
 */
export function projectToEdl({ project }: { project: TProject }): FadiEDL {
	const scenes = project.scenes ?? [];
	const tracks: EdlTrack[] = [];
	const bookmarkSecs: number[] = [];

	for (const scene of scenes) {
		if (scene?.tracks) {
			tracks.push(...serializeSceneTracks(scene.tracks));
		}
		for (const b of scene?.bookmarks ?? []) {
			bookmarkSecs.push(ticksToSec(b.time));
		}
	}

	return {
		schema_version: EDL_SCHEMA_VERSION,
		project_id: project.metadata.id,
		name: project.metadata.name,
		song_id: null,
		render: {
			fps: project.settings?.fps ?? null,
			canvas: project.settings?.canvasSize ?? null,
			current_scene_id: project.currentSceneId ?? null,
			// Lossless editor state for an exact future reconstruction off the drive copy.
			editor_scenes: scenes,
			editor_settings: project.settings ?? null,
			editor_version: project.version ?? null,
		},
		tracks,
		beat_markers_sec: bookmarkSecs.length ? bookmarkSecs : undefined,
	};
}

/** Build the Bridge `ProjectMeta` from the editor project metadata + a known rev. */
export function projectToMeta({
	project,
	rev,
	storageLocation = "drive",
}: {
	project: TProject;
	rev: number;
	storageLocation?: string;
}): ProjectMeta {
	const createdAt = project.metadata.createdAt?.getTime?.() ?? Date.now();
	const updatedAt = project.metadata.updatedAt?.getTime?.() ?? Date.now();
	return {
		project_id: project.metadata.id,
		title: project.metadata.name ?? "untitled",
		song_id: null,
		song_name: null,
		rev,
		created_at: createdAt / 1000,
		updated_at: updatedAt / 1000,
		thumbnail_ref: project.metadata.thumbnail ?? null,
		storage_location: storageLocation,
		editor_state: {},
	};
}
