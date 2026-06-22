/**
 * Browser-side SongContext types + me&u fixture (Batch B slice).
 *
 * Mirrors the FROZEN Python contract `fadi_contracts.song_context.SongContext`
 * (contracts/fadi_contracts/song_context.py). Times are **seconds** — OpenCut
 * converts to MediaTime ticks at the placement edge.
 *
 * For the vertical slice the panel ships the me&u word-aligned lyrics as a local
 * fixture so word/line placement works without a live Bridge round-trip. A later
 * integrator swaps `loadSongContext` to fetch from the Bridge's SongContext
 * provider (bridge/render/song_context_provider.py) — the shapes already match.
 */

export interface Word {
	text: string;
	start_sec: number;
	end_sec: number;
	confidence?: number | null;
}

export interface LyricLine {
	index: number;
	text: string;
	start_sec: number;
	end_sec: number;
	words: Word[];
}

export interface Section {
	index: number;
	name: string;
	start_sec: number;
	end_sec: number;
}

export interface Tempo {
	bpm: number;
	beat_grid: number[];
	downbeats: number[];
}

export interface SongContext {
	song_id: string;
	title: string;
	artist?: string;
	key?: string | null;
	duration_sec: number;
	tempo: Tempo;
	sections: Section[];
	lyrics: LyricLine[];
}

export interface SongSummary {
	id: string;
	title: string;
	bpm: number;
}

// ── me&u fixture (subset of the catalog opening, real timings) ─────────────────

const MEANDU: SongContext = {
	song_id: "me-u-1bc03491",
	title: "me&u",
	artist: "adam fadi",
	key: "A minor",
	duration_sec: 137.232,
	tempo: { bpm: 140, beat_grid: [], downbeats: [] },
	sections: [
		{ index: 0, name: "Intro", start_sec: 0.0, end_sec: 6.86 },
		{ index: 1, name: "Verse", start_sec: 6.86, end_sec: 20.56 },
		{ index: 2, name: "Chorus", start_sec: 20.56, end_sec: 34.28 },
	],
	lyrics: [
		{
			index: 0,
			text: "U & i were planned out",
			start_sec: 6.83,
			end_sec: 9.96,
			words: [
				{ text: "U", start_sec: 6.83, end_sec: 6.97 },
				{ text: "&", start_sec: 6.97, end_sec: 7.11 },
				{ text: "i", start_sec: 7.11, end_sec: 7.3 },
				{ text: "were", start_sec: 7.3, end_sec: 7.6 },
				{ text: "planned", start_sec: 7.6, end_sec: 8.4 },
				{ text: "out", start_sec: 8.4, end_sec: 9.96 },
			],
		},
		{
			index: 1,
			text: "So why’d u switch the plan up?",
			start_sec: 10.03,
			end_sec: 13.17,
			words: [
				{ text: "So", start_sec: 10.03, end_sec: 10.1 },
				{ text: "why’d", start_sec: 10.21, end_sec: 10.38 },
				{ text: "u", start_sec: 10.45, end_sec: 10.52 },
				{ text: "switch", start_sec: 10.6, end_sec: 11.1 },
				{ text: "the", start_sec: 11.1, end_sec: 11.3 },
				{ text: "plan", start_sec: 11.3, end_sec: 11.9 },
				{ text: "up?", start_sec: 11.9, end_sec: 13.17 },
			],
		},
		{
			index: 2,
			text: "it coulda been me & u",
			start_sec: 20.56,
			end_sec: 24.0,
			words: [
				{ text: "it", start_sec: 20.56, end_sec: 20.8 },
				{ text: "coulda", start_sec: 20.8, end_sec: 21.3 },
				{ text: "been", start_sec: 21.3, end_sec: 21.7 },
				{ text: "me", start_sec: 21.7, end_sec: 22.1 },
				{ text: "&", start_sec: 22.1, end_sec: 22.4 },
				{ text: "u", start_sec: 22.4, end_sec: 24.0 },
			],
		},
	],
};

const FIXTURES: Record<string, SongContext> = {
	"me-u-1bc03491": MEANDU,
};

/** Songs available to the picker (fixture-backed for the spike). */
export function listSongs(): SongSummary[] {
	return Object.values(FIXTURES).map((s) => ({
		id: s.song_id,
		title: s.title,
		bpm: s.tempo.bpm,
	}));
}

/** Load a SongContext by id. Spike: fixture only; integrator swaps to Bridge fetch. */
export function loadSongContext(songId: string): SongContext | null {
	return FIXTURES[songId] ?? null;
}
