"use client";

/**
 * Fadi Lyrics panel (Batch B — the end-to-end vertical slice).
 *
 * Pick a song → auto-place its word/line text elements at their timestamps with an
 * approximate browser preview (font / stroke / strobe). Optionally fire the native
 * authoritative bake (meandu engine) via the Bridge and watch SSE progress to a
 * transparent lyric .mov.
 *
 * Wiring discipline: this exports a *mountable* component (`FadiLyricsPanel`) and a
 * typed bridge call (`submitLyricBake`, re-exported). Nothing global is touched —
 * the integrator mounts this wherever the editor's panel registry wants it.
 */

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";
import { listSongs, loadSongContext } from "./song-context";
import {
	countCues,
	placeLyrics,
	type LyricPreviewStyle,
	type PlacementGranularity,
} from "./place-lyrics";
import {
	type BridgeConfig,
	type JobStatus,
	submitLyricBake,
	subscribeJobProgress,
} from "./bridge-client";

// Fadi-color strobe palette for the approximate preview.
const FADI_PALETTE = [
	"#ff2d2d",
	"#ff8a00",
	"#ffe600",
	"#3cff3c",
	"#00cfff",
	"#7a5cff",
	"#ff4fd8",
];

export interface FadiLyricsPanelProps {
	/** Bridge connection (baseUrl + token). Omit to use localhost defaults. */
	bridgeConfig?: BridgeConfig;
}

interface BakeState {
	jobId: string | null;
	status: JobStatus | "idle";
	progress: number;
	message: string;
	outPath: string | null;
	error: string | null;
}

const IDLE_BAKE: BakeState = {
	jobId: null,
	status: "idle",
	progress: 0,
	message: "",
	outPath: null,
	error: null,
};

export function FadiLyricsPanel({ bridgeConfig }: FadiLyricsPanelProps) {
	const editor = useEditor();
	const songs = useMemo(() => listSongs(), []);
	const [songId, setSongId] = useState<string>(songs[0]?.id ?? "");
	const [granularity, setGranularity] = useState<PlacementGranularity>("line");
	const [strobe, setStrobe] = useState(false);
	const [placedTrackId, setPlacedTrackId] = useState<string | null>(null);
	const [bake, setBake] = useState<BakeState>(IDLE_BAKE);
	const unsubRef = useRef<(() => void) | null>(null);

	const song = useMemo(() => loadSongContext(songId), [songId]);

	const previewStyle: LyricPreviewStyle = useMemo(
		() => ({
			color: "#ffffff",
			tracking: -0.02,
			fontSizeRatioOfPlayHeight: granularity === "word" ? 0.16 : 0.11,
			verticalAlign: "middle",
			strobePalette: strobe ? FADI_PALETTE : undefined,
		}),
		[granularity, strobe],
	);

	const cueCount = useMemo(
		() => (song ? countCues({ song, granularity }) : 0),
		[song, granularity],
	);

	function handlePlace() {
		if (!song) return;
		const trackId = placeLyrics({
			editor,
			song,
			granularity,
			style: previewStyle,
		});
		setPlacedTrackId(trackId);
	}

	function handleBake() {
		if (!song) return;
		// Bake the full lyric span [first cue start, last cue end] as one slice.
		const first = song.lyrics[0];
		const last = song.lyrics[song.lyrics.length - 1];
		if (!first || !last) return;
		const startSec = first.start_sec;
		const durationSec = Math.max(0.1, last.end_sec - first.start_sec);

		unsubRef.current?.();
		setBake({ ...IDLE_BAKE, status: "queued", message: "submitting…" });

		submitLyricBake({
			payload: {
				song_id: song.song_id,
				start_sec: startSec,
				duration_sec: durationSec,
				fill_mode: strobe ? "strobe" : "tri_zone",
				smoke_frames: 120, // fast spike bake
			},
			config: bridgeConfig,
		})
			.then((job) => {
				setBake((b) => ({ ...b, jobId: job.id, status: job.status }));
				unsubRef.current = subscribeJobProgress({
					jobId: job.id,
					config: bridgeConfig,
					onProgress: (evt) =>
						setBake((b) => ({
							...b,
							status: evt.status,
							progress: evt.progress,
							message: evt.message,
						})),
					onDone: (evt) =>
						setBake((b) => ({
							...b,
							status: evt.status,
							progress: evt.progress,
							message: evt.message,
							outPath: evt.result?.out_path ?? null,
							error: evt.error,
						})),
					onError: (err) =>
						setBake((b) => ({ ...b, status: "failed", error: err.message })),
				});
			})
			.catch((err: unknown) =>
				setBake((b) => ({
					...b,
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
				})),
			);
	}

	const baking = bake.status === "queued" || bake.status === "running";

	return (
		<div className="panel bg-background flex h-full flex-col gap-4 overflow-y-auto rounded-sm border p-4">
			<div>
				<h2 className="text-sm font-semibold">Fadi Lyrics</h2>
				<p className="text-muted-foreground text-xs">
					Beat-aligned lyric placement + native bake.
				</p>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">Song</Label>
				<Select value={songId} onValueChange={setSongId}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder="Pick a song" />
					</SelectTrigger>
					<SelectContent>
						{songs.map((s) => (
							<SelectItem key={s.id} value={s.id}>
								{s.title} · {s.bpm} BPM
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">Granularity</Label>
				<Select
					value={granularity}
					onValueChange={(v) => setGranularity(v as PlacementGranularity)}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="line">Line by line</SelectItem>
						<SelectItem value="word">Word by word</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<label className="flex items-center gap-2 text-xs">
				<input
					type="checkbox"
					checked={strobe}
					onChange={(e) => setStrobe(e.target.checked)}
				/>
				Fadi-color strobe (preview)
			</label>

			<div className="text-muted-foreground text-xs">
				{song ? (
					<>
						{cueCount} {granularity === "word" ? "words" : "lines"} ·{" "}
						{song.lyrics.length} lyric lines · {song.tempo.bpm} BPM
						{song.key ? ` · ${song.key}` : ""}
					</>
				) : (
					"No song loaded."
				)}
			</div>

			<Button onClick={handlePlace} disabled={!song || cueCount === 0}>
				Place lyrics on timeline
			</Button>
			{placedTrackId ? (
				<p className="text-muted-foreground text-xs">
					Placed {cueCount} text elements on a new track.
				</p>
			) : null}

			<div className="border-t pt-3">
				<Button
					variant="secondary"
					className="w-full"
					onClick={handleBake}
					disabled={!song || baking}
				>
					{baking ? "Baking…" : "Bake transparent lyric .mov (native)"}
				</Button>

				{bake.status !== "idle" ? (
					<div className="mt-2 text-xs">
						<div className="text-muted-foreground">
							{bake.status} · {Math.round(bake.progress * 100)}%
							{bake.message ? ` · ${bake.message}` : ""}
						</div>
						{bake.outPath ? (
							<div className="mt-1 break-all text-green-600">
								→ {bake.outPath}
							</div>
						) : null}
						{bake.error ? (
							<div className="mt-1 break-all text-red-600">{bake.error}</div>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

// Re-export the typed bridge call so the integrator can wire it without reaching in.
export { submitLyricBake } from "./bridge-client";
export type {
	BridgeConfig,
	MeanduLyricJobPayload,
	MeanduLyricResult,
} from "./bridge-client";
export { placeLyrics, buildCues, countCues } from "./place-lyrics";
export { listSongs, loadSongContext } from "./song-context";
export type { SongContext } from "./song-context";

export default FadiLyricsPanel;
