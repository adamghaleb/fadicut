/**
 * Local TS mirror of the slice of the FROZEN Fadi contracts this module touches.
 *
 * The canonical source is the Pydantic models at
 *   contracts/fadi_contracts/song_context.py  (SongContext.tempo, Section)
 *   contracts/fadi_contracts/fadi_edl.py       (BeatLock)
 * and the generated TS lives (eventually) under apps/web/src/fadi/contracts.
 *
 * We mirror only the fields we read so this batch compiles standalone without
 * editing or depending on another batch's generated-types file. When the generated
 * `@/fadi/contracts` import exists, the integrator can delete this file and re-point
 * imports — the field names/shapes here match the contract 1:1 (all times = seconds).
 *
 * DO NOT add fields the contract doesn't have. This is a read-only view.
 */

/** Mirror of song_context.Tempo (times in SECONDS). */
export interface ContractTempo {
	bpm: number;
	bpm_confidence?: number | null;
	time_signature?: { numerator: number; denominator: number };
	/** Absolute seconds of every detected beat. */
	beat_grid: number[];
	/** Absolute seconds of every downbeat (bar start). */
	downbeats: number[];
}

/** Mirror of song_context.Section (times in SECONDS). */
export interface ContractSection {
	index: number;
	name: string;
	start_sec: number;
	end_sec: number;
}

/** The slice of song_context.SongContext this module consumes. */
export interface SongContextSlice {
	song_id: string;
	title?: string;
	tempo: ContractTempo;
	sections?: ContractSection[];
}

/** Mirror of fadi_edl.BeatLock. */
export interface BeatLock {
	beat_index: number;
	downbeat: boolean;
	edge: "start" | "end";
}
