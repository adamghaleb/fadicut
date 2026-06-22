/**
 * Auto-place lyric text elements at their timestamps (Batch B slice).
 *
 * Given a SongContext, build a text track whose elements are the song's lines (or
 * individual words) positioned at their `start_sec`, each lasting until the next
 * cue. Reuses OpenCut's own subtitle plumbing so the result is indistinguishable
 * from hand-authored text:
 *   - `buildSubtitleTextElement` (measures + positions, seconds → MediaTime at the edge)
 *   - `AddTrackCommand` + `InsertElementCommand` + `BatchCommand` (undoable, one batch)
 *
 * Scope: this file only orchestrates existing OpenCut APIs; it doesn't fork the
 * timeline model. The Fadi lyric *effect* (stroke/strobe/tri-zone) and its native
 * bake live behind the bridge client — here we just lay down editable text the
 * browser previews approximately.
 */

import type { EditorCore } from "@/core";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
} from "@/commands";
import { buildSubtitleTextElement } from "@/subtitles/build-subtitle-text-element";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import type { LyricLine, SongContext, Word } from "./song-context";

export type PlacementGranularity = "line" | "word";

/** Approximate browser preview of the Fadi lyric look (fonts / stroke / strobe). */
export interface LyricPreviewStyle {
	fontFamily?: string;
	/** Fraction of canvas height (subtitle builder converts to app units). */
	fontSizeRatioOfPlayHeight?: number;
	color?: string;
	/** Outline color — only honored when fully white text (Adam's rule). */
	strokeColor?: string;
	/** Approximate strobe: cycle text color across this palette per cue. */
	strobePalette?: string[];
	tracking?: number;
	verticalAlign?: "top" | "middle" | "bottom";
}

const DEFAULT_PREVIEW: Required<
	Pick<
		LyricPreviewStyle,
		| "fontFamily"
		| "fontSizeRatioOfPlayHeight"
		| "color"
		| "tracking"
		| "verticalAlign"
	>
> = {
	fontFamily: "Arial",
	fontSizeRatioOfPlayHeight: 0.11,
	color: "#ffffff",
	tracking: -0.02,
	verticalAlign: "middle",
};

interface Cue {
	text: string;
	startSec: number;
	endSec: number;
}

/** Flatten a SongContext's lyrics into line- or word-level cues with timing. */
export function buildCues({
	song,
	granularity,
	lineRange,
}: {
	song: SongContext;
	granularity: PlacementGranularity;
	lineRange?: [number, number];
}): Cue[] {
	const lines = clampLineRange({ lyrics: song.lyrics, lineRange });
	if (granularity === "line") {
		return lines.map((ln) => ({
			text: ln.text,
			startSec: ln.start_sec,
			endSec: ln.end_sec,
		}));
	}
	const cues: Cue[] = [];
	for (const ln of lines) {
		for (const w of ln.words) {
			cues.push({ text: w.text, startSec: w.start_sec, endSec: w.end_sec });
		}
	}
	return cues;
}

function clampLineRange({
	lyrics,
	lineRange,
}: {
	lyrics: LyricLine[];
	lineRange?: [number, number];
}): LyricLine[] {
	if (!lineRange) return lyrics;
	const [a, b] = lineRange;
	return lyrics.filter((ln) => ln.index >= a && ln.index <= b);
}

/**
 * Map a preview style + cue index to subtitle style overrides. Strobe = pick a
 * palette color by cue index; stroke only applied when text is pure white (rule).
 */
function cueStyle({
	style,
	index,
}: {
	style: LyricPreviewStyle;
	index: number;
}): SubtitleStyleOverrides {
	const color =
		style.strobePalette && style.strobePalette.length > 0
			? style.strobePalette[index % style.strobePalette.length]
			: (style.color ?? DEFAULT_PREVIEW.color);

	const overrides: SubtitleStyleOverrides = {
		fontFamily: style.fontFamily ?? DEFAULT_PREVIEW.fontFamily,
		fontSizeRatioOfPlayHeight:
			style.fontSizeRatioOfPlayHeight ??
			DEFAULT_PREVIEW.fontSizeRatioOfPlayHeight,
		color,
		fontWeight: "bold",
		letterSpacing: style.tracking ?? DEFAULT_PREVIEW.tracking,
		placement: {
			verticalAlign: style.verticalAlign ?? DEFAULT_PREVIEW.verticalAlign,
		},
	};
	return overrides;
}

/**
 * Place lyric cues as a new text track on the active scene. Returns the new
 * track id, or null if there were no cues. The whole insert is one undoable batch.
 */
export function placeLyrics({
	editor,
	song,
	granularity = "line",
	lineRange,
	style = {},
}: {
	editor: EditorCore;
	song: SongContext;
	granularity?: PlacementGranularity;
	lineRange?: [number, number];
	style?: LyricPreviewStyle;
}): string | null {
	const cues = buildCues({ song, granularity, lineRange });
	if (cues.length === 0) return null;

	const canvasSize = editor.project.getActive().settings.canvasSize;

	const addTrackCommand = new AddTrackCommand({ type: "text", index: 0 });
	const trackId = addTrackCommand.getTrackId();

	const insertCommands = cues.map((cue, index) => {
		const subtitleCue: SubtitleCue = {
			text: cue.text,
			startTime: cue.startSec,
			duration: Math.max(0.05, cue.endSec - cue.startSec),
			style: cueStyle({ style, index }),
		};
		return new InsertElementCommand({
			placement: { mode: "explicit", trackId },
			element: buildSubtitleTextElement({
				index,
				caption: subtitleCue,
				canvasSize,
			}),
		});
	});

	editor.command.execute({
		command: new BatchCommand([addTrackCommand, ...insertCommands]),
	});

	return trackId;
}

/** Count cues a given config would place (for the UI preview/confirm). */
export function countCues({
	song,
	granularity,
	lineRange,
}: {
	song: SongContext;
	granularity: PlacementGranularity;
	lineRange?: [number, number];
}): number {
	return buildCues({ song, granularity, lineRange }).length;
}

export type { Word };
