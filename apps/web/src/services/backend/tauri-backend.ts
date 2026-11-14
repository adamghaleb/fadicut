// ---------------------------------------------------------------------------
// Tauri (native) backend implementation
//
// Delegates heavy lifting to Rust via `@tauri-apps/api/core` invoke + Channel.
// Rust commands handle FFmpeg-based encoding/decoding, native file dialogs,
// and GPU-accelerated compositing when available.
//
// This file is only imported when `isTauri()` returns true (dynamic import).
// ---------------------------------------------------------------------------

import type {
	EditorBackend,
	RenderBackend,
	EncodeBackend,
	EncodeSession,
	EncodeParams,
	DecodeBackend,
	FileIOBackend,
	FileHandle,
	AudioBackend,
	CompositeLayer,
	FrameImage,
	ProgressEvent,
	MediaProbe,
	AudioPeaks,
	AudioMixClip,
} from "./types";

// ---------------------------------------------------------------------------
// Tauri IPC helpers
// ---------------------------------------------------------------------------

async function tauriInvoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(cmd, args);
}

async function tauriChannel<T>() {
	const { Channel } = await import("@tauri-apps/api/core");
	return new Channel<T>();
}

// ---- Render ---------------------------------------------------------------

const tauriRender: RenderBackend = {
	async composite({ layers, width, height, background }) {
		// Serialize layers for IPC — strip ImageBitmap, send only Uint8Array.
		const serializedLayers = await Promise.all(
			layers.map(async (layer) => {
				let pixelData: Uint8Array;
				if (layer.source instanceof ImageBitmap) {
					const canvas = new OffscreenCanvas(layer.width, layer.height);
					const ctx = canvas.getContext("2d")!;
					ctx.drawImage(layer.source, 0, 0);
					const imageData = ctx.getImageData(0, 0, layer.width, layer.height);
					pixelData = new Uint8Array(imageData.data.buffer);
				} else {
					pixelData = layer.source;
				}

				return {
					type: layer.type,
					data: Array.from(pixelData), // JSON-serializable for IPC
					x: layer.x,
					y: layer.y,
					width: layer.width,
					height: layer.height,
					opacity: layer.opacity,
					blendMode: layer.blendMode,
					zIndex: layer.zIndex,
				};
			}),
		);

		const result = await tauriInvoke<number[]>("composite_frame", {
			layers: serializedLayers,
			width,
			height,
			background,
		});

		return new Uint8Array(result);
	},
};

// ---- Encode ---------------------------------------------------------------

const tauriEncode: EncodeBackend = {
	async encode(params: EncodeParams): Promise<EncodeSession> {
		// Tell Rust to set up an FFmpeg encoding pipeline and return a session ID.
		const sessionId = await tauriInvoke<string>("encode_start", {
			width: params.width,
			height: params.height,
			fps: params.fps,
			format: params.format,
			quality: params.quality,
			totalFrames: params.totalFrames,
		});

		let cancelled = false;

		return {
			async addFrame(frame: Uint8Array, timestampSeconds: number) {
				if (cancelled) return;
				await tauriInvoke("encode_add_frame", {
					sessionId,
					frame: Array.from(frame),
					timestamp: timestampSeconds,
				});
			},

			async addAudio(pcm: Float32Array, sampleRate: number, channels: number) {
				if (cancelled) return;
				await tauriInvoke("encode_add_audio", {
					sessionId,
					pcm: Array.from(pcm),
					sampleRate,
					channels,
				});
			},

			async *finalize(): AsyncGenerator<ProgressEvent, Uint8Array> {
				if (cancelled) {
					yield { stage: "error", message: "Encode was cancelled" };
					return new Uint8Array(0);
				}

				// Use a Tauri Channel to stream progress events from Rust
				type RustProgress = {
					stage: string;
					progress?: number;
					message?: string;
				};

				const channel = await tauriChannel<RustProgress>();
				const events: ProgressEvent[] = [];
				let resolveWait: (() => void) | null = null;

				channel.onmessage = (msg) => {
					const event = parseRustProgress(msg);
					events.push(event);
					resolveWait?.();
				};

				// Kick off finalization in Rust (non-blocking)
				const finalizePromise = tauriInvoke<number[]>("encode_finalize", {
					sessionId,
					onProgress: channel,
				});

				// Yield progress events as they arrive
				while (true) {
					if (events.length > 0) {
						const event = events.shift()!;
						yield event;
						if (event.stage === "done" || event.stage === "error") break;
					} else {
						await new Promise<void>((r) => {
							resolveWait = r;
						});
					}
				}

				const result = await finalizePromise;
				return new Uint8Array(result);
			},

			cancel() {
				cancelled = true;
				void tauriInvoke("encode_cancel", { sessionId });
			},
		};
	},
};

function parseRustProgress(msg: {
	stage: string;
	progress?: number;
	message?: string;
}): ProgressEvent {
	switch (msg.stage) {
		case "encoding":
			return { stage: "encoding", progress: msg.progress ?? 0 };
		case "done":
			return { stage: "done" };
		case "error":
			return { stage: "error", message: msg.message ?? "Unknown error" };
		default:
			return { stage: "encoding", progress: msg.progress ?? 0 };
	}
}

// ---- Decode ---------------------------------------------------------------

const tauriDecode: DecodeBackend = {
	async probe(file) {
		const bytes =
			file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;

		return tauriInvoke<MediaProbe>("probe_media", {
			data: Array.from(bytes),
		});
	},

	async *decodeFrames({ file, startTime, endTime }) {
		const bytes =
			file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;

		type FrameEvent = {
			data: number[];
			width: number;
			height: number;
			timestamp: number;
			done: boolean;
		};

		const channel = await tauriChannel<FrameEvent>();
		const frames: FrameImage[] = [];
		let isDone = false;
		let resolveWait: (() => void) | null = null;

		channel.onmessage = (msg) => {
			if (msg.done) {
				isDone = true;
			} else {
				frames.push({
					data: new Uint8Array(msg.data),
					width: msg.width,
					height: msg.height,
					timestamp: msg.timestamp,
				});
			}
			resolveWait?.();
		};

		// Start decoding in Rust
		void tauriInvoke("decode_frames", {
			data: Array.from(bytes),
			startTime,
			endTime: endTime ?? null,
			onFrame: channel,
		});

		while (true) {
			if (frames.length > 0) {
				yield frames.shift()!;
			} else if (isDone) {
				break;
			} else {
				await new Promise<void>((r) => {
					resolveWait = r;
				});
			}
		}
	},

	async getFrameAt({ file, time, width, height }) {
		const bytes =
			file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;

		const result = await tauriInvoke<{
			data: number[];
			width: number;
			height: number;
			timestamp: number;
		}>("get_frame_at", {
			data: Array.from(bytes),
			time,
			width: width ?? null,
			height: height ?? null,
		});

		return {
			data: new Uint8Array(result.data),
			width: result.width,
			height: result.height,
			timestamp: result.timestamp,
		};
	},
};

// ---- File I/O -------------------------------------------------------------

const tauriFileIO: FileIOBackend = {
	async readFile(path) {
		const result = await tauriInvoke<number[]>("read_file", { path });
		return new Uint8Array(result);
	},

	async writeFile(path, data) {
		await tauriInvoke("write_file", {
			path,
			data: Array.from(data),
		});
	},

	async pickFile({ accept, multiple }) {
		const { open } = await import("@tauri-apps/plugin-dialog");

		const result = await open({
			multiple: multiple ?? false,
			filters: accept?.length
				? [{ name: "Media", extensions: accept.map((a) => a.replace(".", "")) }]
				: undefined,
		});

		if (!result) return null;

		const paths = Array.isArray(result) ? result : [result];

		return paths.map((filePath): FileHandle => ({
			name: filePath.split("/").pop() ?? filePath,
			path: filePath,
			size: 0, // Size resolved lazily when read
			async read() {
				return tauriInvoke<number[]>("read_file", { path: filePath }).then(
					(bytes) => new Uint8Array(bytes),
				);
			},
			toFile() {
				return null; // No browser File object in native context
			},
		}));
	},

	async pickSaveLocation({ defaultName, accept }) {
		const { save } = await import("@tauri-apps/plugin-dialog");

		const result = await save({
			defaultPath: defaultName,
			filters: accept?.length
				? [
						{
							name: "Export",
							extensions: accept.map((a) => a.replace(".", "")),
						},
					]
				: undefined,
		});

		return result ?? null;
	},

	async deleteFile(path) {
		await tauriInvoke("delete_file", { path });
	},

	async exists(path) {
		return tauriInvoke<boolean>("file_exists", { path });
	},

	async getTempDir() {
		return tauriInvoke<string>("get_temp_dir");
	},
};

// ---- Audio ----------------------------------------------------------------

const tauriAudio: AudioBackend = {
	async extractPeaks({ file, length }) {
		const bytes =
			file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;

		return tauriInvoke<AudioPeaks>("extract_audio_peaks", {
			data: Array.from(bytes),
			length,
		});
	},

	async decodeAudio({ file, sampleRate }) {
		const bytes =
			file instanceof File ? new Uint8Array(await file.arrayBuffer()) : file;

		const result = await tauriInvoke<{
			pcm: number[][];
			sampleRate: number;
			channels: number;
			duration: number;
		}>("decode_audio", {
			data: Array.from(bytes),
			sampleRate: sampleRate ?? 44100,
		});

		return {
			pcm: result.pcm.map((ch) => new Float32Array(ch)),
			sampleRate: result.sampleRate,
			channels: result.channels,
			duration: result.duration,
		};
	},

	async *mixAudio({ clips, duration, sampleRate }) {
		const rate = sampleRate ?? 44100;

		type MixProgress = {
			stage: string;
			progress?: number;
		};

		const channel = await tauriChannel<MixProgress>();
		const events: ProgressEvent[] = [];
		let resolveWait: (() => void) | null = null;

		channel.onmessage = (msg) => {
			const event: ProgressEvent =
				msg.stage === "done"
					? { stage: "done" }
					: { stage: "mixing", progress: msg.progress ?? 0 };
			events.push(event);
			resolveWait?.();
		};

		const serializedClips = clips.map((clip) => ({
			pcm: clip.pcm.map((ch) => Array.from(ch)),
			sampleRate: clip.sampleRate,
			startTime: clip.startTime,
			duration: clip.duration,
			trimStart: clip.trimStart,
			volume: clip.volume,
			muted: clip.muted,
		}));

		const resultPromise = tauriInvoke<number[][]>("mix_audio", {
			clips: serializedClips,
			duration,
			sampleRate: rate,
			onProgress: channel,
		});

		while (true) {
			if (events.length > 0) {
				const event = events.shift()!;
				yield event;
				if (event.stage === "done" || event.stage === "error") break;
			} else {
				await new Promise<void>((r) => {
					resolveWait = r;
				});
			}
		}

		const result = await resultPromise;
		return result.map((ch) => new Float32Array(ch));
	},
};

// ---- Factory --------------------------------------------------------------

export function createTauriBackend(): EditorBackend {
	return {
		runtime: "tauri",
		render: tauriRender,
		encode: tauriEncode,
		decode: tauriDecode,
		fileIO: tauriFileIO,
		audio: tauriAudio,
	};
}
