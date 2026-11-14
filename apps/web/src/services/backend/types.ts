// ---------------------------------------------------------------------------
// Backend abstraction types for fadi-cut
// Defines the contract that both the browser (Web API) and Tauri (native)
// implementations must satisfy.
// ---------------------------------------------------------------------------

import type { ExportFormat, ExportQuality } from "@/types/export";

// ---- Shared primitives ----------------------------------------------------

/** A decoded video/image frame ready for compositing. */
export interface FrameImage {
	/** Raw RGBA pixel data. */
	data: Uint8Array;
	width: number;
	height: number;
	/** Presentation timestamp in seconds. */
	timestamp: number;
}

/** Progress event emitted by long-running operations. */
export type ProgressEvent =
	| { stage: "encoding"; progress: number } // 0..1
	| { stage: "decoding"; progress: number }
	| { stage: "mixing"; progress: number }
	| { stage: "done" }
	| { stage: "error"; message: string };

/** Description of a compositing layer for a single frame. */
export interface CompositeLayer {
	type: "video" | "image" | "text" | "color" | "sticker";
	/** Raw RGBA pixel data or an ImageBitmap for web. */
	source: Uint8Array | ImageBitmap;
	x: number;
	y: number;
	width: number;
	height: number;
	opacity: number;
	blendMode: string;
	/** Layer z-order — higher renders on top. */
	zIndex: number;
}

/** Minimal metadata returned when probing a media file. */
export interface MediaProbe {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	codec: string;
}

/** Audio peaks data — one array of peak values per channel. */
export type AudioPeaks = number[][];

// ---- Rendering backend ----------------------------------------------------

export interface RenderBackend {
	/**
	 * Composite layers into a single RGBA frame.
	 * Returns raw pixel data (Uint8Array) of size width * height * 4.
	 */
	composite(params: {
		layers: CompositeLayer[];
		width: number;
		height: number;
		background: string;
	}): Promise<Uint8Array>;
}

// ---- Encoding / Export backend --------------------------------------------

export interface EncodeParams {
	width: number;
	height: number;
	fps: number;
	format: ExportFormat;
	quality: ExportQuality;
	totalFrames: number;
}

export interface EncodeBackend {
	/**
	 * Start an encoding session. Feed frames via `addFrame`, then call
	 * `finalize` to get the output buffer.
	 *
	 * Progress is reported via the returned async generator — yield
	 * `ProgressEvent` items and return the final buffer.
	 */
	encode(params: EncodeParams): Promise<EncodeSession>;
}

export interface EncodeSession {
	/** Push a rendered RGBA frame. */
	addFrame(frame: Uint8Array, timestampSeconds: number): Promise<void>;

	/** Optionally attach a mixed-down audio buffer. */
	addAudio?(
		pcm: Float32Array,
		sampleRate: number,
		channels: number,
	): Promise<void>;

	/** Signal the end of input and get the muxed file bytes. */
	finalize(): AsyncGenerator<ProgressEvent, Uint8Array>;

	/** Cancel a running encode. Safe to call multiple times. */
	cancel(): void;
}

// ---- Decoding backend -----------------------------------------------------

export interface DecodeBackend {
	/** Probe a media file for metadata without fully decoding it. */
	probe(file: Uint8Array | File): Promise<MediaProbe>;

	/**
	 * Decode video frames on demand. Returns an async generator that yields
	 * frames starting from `startTime`.
	 *
	 * The caller drives playback speed by pulling from the generator.
	 */
	decodeFrames(params: {
		file: Uint8Array | File;
		startTime: number;
		endTime?: number;
	}): AsyncGenerator<FrameImage>;

	/**
	 * Grab a single frame at the specified time — used for thumbnails.
	 */
	getFrameAt(params: {
		file: Uint8Array | File;
		time: number;
		width?: number;
		height?: number;
	}): Promise<FrameImage>;
}

// ---- File I/O backend -----------------------------------------------------

export interface FileIOBackend {
	/** Read a file fully into memory. */
	readFile(path: string): Promise<Uint8Array>;

	/** Write bytes to a file, creating or overwriting. */
	writeFile(path: string, data: Uint8Array): Promise<void>;

	/** Show a native "open file" picker. Returns null if cancelled. */
	pickFile(params: {
		accept?: string[];
		multiple?: boolean;
	}): Promise<FileHandle[] | null>;

	/** Show a native "save file" picker. Returns null if cancelled. */
	pickSaveLocation(params: {
		defaultName?: string;
		accept?: string[];
	}): Promise<string | null>;

	/** Delete a file. No-op if it doesn't exist. */
	deleteFile(path: string): Promise<void>;

	/** Check if a file/path exists. */
	exists(path: string): Promise<boolean>;

	/** Get a temporary directory path (native) or an OPFS root (browser). */
	getTempDir(): Promise<string>;
}

/** A thin handle over a picked file — abstracts File vs Tauri path. */
export interface FileHandle {
	/** Display name of the file. */
	name: string;
	/** Native: full filesystem path. Browser: in-memory or blob URL. */
	path: string;
	/** Size in bytes. */
	size: number;
	/** Read the full file into memory. */
	read(): Promise<Uint8Array>;
	/** Get a File object (browser) or null (native). */
	toFile(): File | null;
}

// ---- Audio backend --------------------------------------------------------

export interface AudioBackend {
	/** Extract waveform peaks for visualization. */
	extractPeaks(params: {
		file: Uint8Array | File;
		/** Number of peak buckets to return. */
		length: number;
	}): Promise<AudioPeaks>;

	/** Decode audio from a media file into raw PCM. */
	decodeAudio(params: {
		file: Uint8Array | File;
		sampleRate?: number;
	}): Promise<{
		pcm: Float32Array[];
		sampleRate: number;
		channels: number;
		duration: number;
	}>;

	/**
	 * Mix multiple audio clips into a single stereo buffer.
	 * Each clip specifies its timeline position and trim.
	 */
	mixAudio(params: {
		clips: AudioMixClip[];
		duration: number;
		sampleRate?: number;
	}): AsyncGenerator<ProgressEvent, Float32Array[]>;
}

export interface AudioMixClip {
	/** Raw PCM data per channel. */
	pcm: Float32Array[];
	sampleRate: number;
	/** When this clip starts on the timeline, in seconds. */
	startTime: number;
	/** Clip playback duration in seconds. */
	duration: number;
	/** Trim from the beginning of the source, in seconds. */
	trimStart: number;
	/** Volume multiplier, 0..1. */
	volume: number;
	muted: boolean;
}

// ---- Unified backend interface --------------------------------------------

export interface EditorBackend {
	readonly runtime: "browser" | "tauri";
	readonly render: RenderBackend;
	readonly encode: EncodeBackend;
	readonly decode: DecodeBackend;
	readonly fileIO: FileIOBackend;
	readonly audio: AudioBackend;
}
