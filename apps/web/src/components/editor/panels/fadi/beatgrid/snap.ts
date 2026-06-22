/**
 * Snap-to-beat helpers (Batch C, editor side).
 *
 * Pure functions that snap a time (clip edge / cut / playhead) onto the song's beat
 * grid, and resolve a `BeatLock` (from FadiEDL) back to an absolute time. The timeline
 * works in MediaTime ticks; the contract beat grid is in seconds — these helpers accept
 * MediaTime and convert at the edge so callers stay in timeline units.
 *
 * Nothing here mutates a store. The integrator wires the returned snapped time into a
 * trim/move command. Snapping is OPT-IN per call (the timeline keeps its own frame
 * snapping); beat snapping is layered on top when the user holds the beat-snap modifier
 * or a clip carries a BeatLock.
 */

import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
} from "@/wasm";
import type { BeatLock, SongContextSlice } from "./contract-types";

export type Grid = "beat" | "downbeat";

export interface SnapResult {
	/** The snapped time in MediaTime ticks. */
	time: MediaTime;
	/** Index into the chosen grid (beat_grid or downbeats) that we snapped to. */
	gridIndex: number;
	/** Absolute seconds of the snap target (contract units). */
	seconds: number;
	/** Distance moved, in seconds (signed: target - input). */
	deltaSec: number;
}

function gridArray(ctx: SongContextSlice, grid: Grid): number[] {
	return grid === "downbeat" ? ctx.tempo.downbeats : ctx.tempo.beat_grid;
}

/** Find the index of the nearest value in a sorted ascending array (binary search). */
function nearestIndex(sorted: number[], value: number): number {
	if (sorted.length === 0) return -1;
	let lo = 0;
	let hi = sorted.length - 1;
	if (value <= sorted[lo]) return lo;
	if (value >= sorted[hi]) return hi;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] === value) return mid;
		if (sorted[mid] < value) lo = mid + 1;
		else hi = mid - 1;
	}
	// lo is the first index > value; compare neighbours lo and lo-1
	const hiV = sorted[lo];
	const loV = sorted[lo - 1];
	return value - loV <= hiV - value ? lo - 1 : lo;
}

/**
 * Snap a MediaTime onto the song's beat (or downbeat) grid.
 *
 * `toleranceSec` (optional): if the nearest beat is farther than this, return the input
 * unchanged (gridIndex -1). Use it for "magnetic" snapping that only engages near a
 * beat. Omit for always-snap.
 */
export function snapToBeat(
	time: MediaTime,
	ctx: SongContextSlice,
	options: { grid?: Grid; toleranceSec?: number } = {},
): SnapResult {
	const grid = options.grid ?? "beat";
	const arr = gridArray(ctx, grid);
	const seconds = mediaTimeToSeconds({ time });

	const idx = nearestIndex(arr, seconds);
	if (idx < 0) {
		return { time, gridIndex: -1, seconds, deltaSec: 0 };
	}
	const target = arr[idx];
	const delta = target - seconds;
	if (
		options.toleranceSec !== undefined &&
		Math.abs(delta) > options.toleranceSec
	) {
		return { time, gridIndex: -1, seconds, deltaSec: 0 };
	}
	return {
		time: mediaTimeFromSeconds({ seconds: target }),
		gridIndex: idx,
		seconds: target,
		deltaSec: delta,
	};
}

/**
 * Snap and return just the MediaTime — convenience for command code that only needs the
 * value. Falls back to the input time when there's no grid / outside tolerance.
 */
export function snapMediaTimeToBeat(
	time: MediaTime,
	ctx: SongContextSlice,
	options: { grid?: Grid; toleranceSec?: number } = {},
): MediaTime {
	return snapToBeat(time, ctx, options).time;
}

/**
 * Resolve a FadiEDL `BeatLock` to an absolute time on the grid.
 *
 * BeatLock stores a beat index (into the beat grid, or — when `downbeat` — the downbeat
 * grid). Returns the locked time in MediaTime, or null if the index is out of range.
 * This is how a beat-locked clip edge stays in sync when the BPM is re-detected: the
 * editor re-resolves the lock against the new grid.
 */
export function resolveBeatLock(
	lock: BeatLock,
	ctx: SongContextSlice,
): { time: MediaTime; seconds: number } | null {
	const arr = lock.downbeat ? ctx.tempo.downbeats : ctx.tempo.beat_grid;
	if (lock.beat_index < 0 || lock.beat_index >= arr.length) return null;
	const seconds = arr[lock.beat_index];
	return { time: mediaTimeFromSeconds({ seconds }), seconds };
}

/**
 * Build the `BeatLock` that snapping a given edge to a grid index implies, so a caller
 * that snaps a clip edge can persist the lock onto the FadiEDL element. `edge` records
 * which edge of the element was locked (start vs end).
 */
export function makeBeatLock(
	gridIndex: number,
	edge: "start" | "end",
	grid: Grid,
): BeatLock {
	return { beat_index: gridIndex, downbeat: grid === "downbeat", edge };
}

/**
 * Snap a clip's [start, end] edges to the grid together, returning new edges + the locks
 * each edge resolved to. Either edge can be excluded (e.g. snap only the cut-in).
 * Durations are preserved by the caller's choice: we return raw snapped edges, so the
 * caller decides whether to keep duration (move) or let it change (trim).
 */
export function snapClipEdges(
	startTime: MediaTime,
	endTime: MediaTime,
	ctx: SongContextSlice,
	options: {
		grid?: Grid;
		snapStart?: boolean;
		snapEnd?: boolean;
		toleranceSec?: number;
	} = {},
): {
	start: SnapResult & { lock: BeatLock | null };
	end: SnapResult & { lock: BeatLock | null };
} {
	const grid = options.grid ?? "beat";
	const snapStart = options.snapStart ?? true;
	const snapEnd = options.snapEnd ?? true;

	const startSnap = snapStart
		? snapToBeat(startTime, ctx, { grid, toleranceSec: options.toleranceSec })
		: {
				time: startTime,
				gridIndex: -1,
				seconds: mediaTimeToSeconds({ time: startTime }),
				deltaSec: 0,
			};
	const endSnap = snapEnd
		? snapToBeat(endTime, ctx, { grid, toleranceSec: options.toleranceSec })
		: {
				time: endTime,
				gridIndex: -1,
				seconds: mediaTimeToSeconds({ time: endTime }),
				deltaSec: 0,
			};

	return {
		start: {
			...startSnap,
			lock:
				startSnap.gridIndex >= 0
					? makeBeatLock(startSnap.gridIndex, "start", grid)
					: null,
		},
		end: {
			...endSnap,
			lock:
				endSnap.gridIndex >= 0
					? makeBeatLock(endSnap.gridIndex, "end", grid)
					: null,
		},
	};
}
