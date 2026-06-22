/**
 * Batch C — BPM / beat-synced editing (editor side).
 *
 * Maps a SongContext's beat grid + section markers onto OpenCut Bookmarks, and provides
 * snap-to-beat helpers for clip edges / cuts that honor FadiEDL `BeatLock`. Pure helpers
 * + a scoped Bridge client — nothing here mutates a store or edits shared timeline files.
 *
 * Integrator wiring (in the timeline UI / a command, NOT here):
 *
 *   import {
 *     detectBeatsAsSlice, songContextToBookmarks, snapMediaTimeToBeat, resolveBeatLock,
 *   } from "@/components/editor/panels/fadi/beatgrid";
 *
 *   const slice = await detectBeatsAsSlice({ songId, audioPath });   // hits the Bridge
 *   const bookmarks = songContextToBookmarks(slice);                 // → Bookmark[]
 *   // commit `bookmarks` onto the active scene via your own command
 *
 *   const snapped = snapMediaTimeToBeat(dragTime, slice, { grid: "downbeat" });
 */

export type {
	BeatLock,
	ContractSection,
	ContractTempo,
	SongContextSlice,
} from "./contract-types";

export {
	BEAT_GRID_COLORS,
	type BeatBookmarkOptions,
	beatGridToBookmarks,
	secondsToMediaTime,
	sectionsToBookmarks,
	songContextToBookmarks,
} from "./bookmarks";

export {
	type Grid,
	makeBeatLock,
	resolveBeatLock,
	snapClipEdges,
	snapMediaTimeToBeat,
	snapToBeat,
	type SnapResult,
} from "./snap";

export {
	type BridgeConfig,
	type DetectBeatsRequest,
	type DetectBeatsResponse,
	detectBeats,
	detectBeatsAsSlice,
	detectBeatsAsync,
	type JobView,
} from "./bridge-client";
