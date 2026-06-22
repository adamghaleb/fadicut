/**
 * Beat + section markers → OpenCut Bookmarks (Batch C, editor side).
 *
 * Per the contract mapping table, the song's beat grid and section markers "ride" on
 * OpenCut's `Bookmark[]`. This module converts a `SongContext` (seconds, contract) into
 * `Bookmark[]` (MediaTime ticks, OpenCut) — the seconds→MediaTime conversion happens
 * here, at the edge, via `mediaTimeFromSeconds`.
 *
 * It is PURE: it returns new Bookmark arrays and never mutates a scene or store. The
 * integrator decides how to commit them (e.g. wrap in a command and call
 * `editor.scenes.setScenes`). This keeps the batch from touching shared timeline files.
 */

import type { Bookmark } from "@/timeline/types";
import { type MediaTime, mediaTimeFromSeconds } from "@/wasm";
import type { ContractSection, SongContextSlice } from "./contract-types";

/** Bookmark colors so beats / downbeats / sections are visually distinct on the ruler. */
export const BEAT_GRID_COLORS = {
	beat: "#3a3a3a",
	downbeat: "#ffffff",
	section: "#ff4d4d",
} as const;

export interface BeatBookmarkOptions {
	/** Include every beat (not just downbeats). Defaults to false to avoid ruler clutter. */
	includeBeats?: boolean;
	/** Include downbeats (bar starts). Defaults to true. */
	includeDownbeats?: boolean;
	/** Include section boundaries. Defaults to true. */
	includeSections?: boolean;
	/** Override colors. */
	colors?: Partial<typeof BEAT_GRID_COLORS>;
}

const DEFAULTS: Required<Omit<BeatBookmarkOptions, "colors">> = {
	includeBeats: false,
	includeDownbeats: true,
	includeSections: true,
};

/** seconds → MediaTime at the edge. */
export function secondsToMediaTime(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds: Math.max(0, seconds) });
}

function beatNote(beatIndex: number, downbeat: boolean): string {
	return downbeat
		? `bar ${Math.floor(beatIndex / 4) + 1}`
		: `beat ${beatIndex + 1}`;
}

/**
 * Build bookmarks for the beat grid (beats and/or downbeats).
 *
 * Downbeats are matched against the beat grid to recover their global beat index, so a
 * downbeat bookmark's note reads "bar N". Beats not in `downbeats` get a thin color.
 */
export function beatGridToBookmarks(
	tempo: SongContextSlice["tempo"],
	options: BeatBookmarkOptions = {},
): Bookmark[] {
	const opts = { ...DEFAULTS, ...options };
	const colors = { ...BEAT_GRID_COLORS, ...(options.colors ?? {}) };
	const downbeatSet = new Set(tempo.downbeats);
	const out: Bookmark[] = [];

	if (opts.includeBeats) {
		for (let i = 0; i < tempo.beat_grid.length; i++) {
			const t = tempo.beat_grid[i];
			const isDown = downbeatSet.has(t);
			if (isDown && !opts.includeDownbeats) continue;
			out.push({
				time: secondsToMediaTime(t),
				note: beatNote(i, isDown),
				color: isDown ? colors.downbeat : colors.beat,
			});
		}
		return out;
	}

	if (opts.includeDownbeats) {
		for (let i = 0; i < tempo.downbeats.length; i++) {
			out.push({
				time: secondsToMediaTime(tempo.downbeats[i]),
				note: `bar ${i + 1}`,
				color: colors.downbeat,
			});
		}
	}
	return out;
}

/** Build a bookmark at the start of each section, labelled with the section name. */
export function sectionsToBookmarks(
	sections: ContractSection[],
	color: string = BEAT_GRID_COLORS.section,
): Bookmark[] {
	return sections.map((s) => ({
		time: secondsToMediaTime(s.start_sec),
		note: s.name,
		color,
	}));
}

/**
 * Full set of beat + section bookmarks for a SongContext, ready to merge into a scene.
 *
 * Sections are emitted last so, when two markers share a frame, the section (with its
 * label) is the one a UI that de-dupes by time tends to keep.
 */
export function songContextToBookmarks(
	ctx: SongContextSlice,
	options: BeatBookmarkOptions = {},
): Bookmark[] {
	const opts = { ...DEFAULTS, ...options };
	const out: Bookmark[] = [];
	if (opts.includeBeats || opts.includeDownbeats) {
		out.push(...beatGridToBookmarks(ctx.tempo, options));
	}
	if (opts.includeSections && ctx.sections?.length) {
		out.push(...sectionsToBookmarks(ctx.sections, options.colors?.section));
	}
	return out;
}
