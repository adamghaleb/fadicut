// ---------------------------------------------------------------------------
// Browser (Web API) backend implementation
//
// Uses Canvas2D/OffscreenCanvas for rendering, WebCodecs + mediabunny for
// encoding/decoding, Web Audio API for audio, and OPFS / File System Access
// API for file I/O.
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

// ---- Render ---------------------------------------------------------------

const browserRender: RenderBackend = {
	async composite({ layers, width, height, background }) {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d")!;

		// Background fill
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, width, height);

		// Sort by zIndex
		const sorted = [...layers].sort((a, b) => a.zIndex - b.zIndex);

		for (const layer of sorted) {
			ctx.save();
			ctx.globalAlpha = layer.opacity;
			ctx.globalCompositeOperation =
				(layer.blendMode as GlobalCompositeOperation) || "source-over";

			let source: ImageBitmap | ImageData;

			if (layer.source instanceof ImageBitmap) {
				source = layer.source;
			} else {
				// Uint8Array RGBA → ImageData
				const clamped = new Uint8ClampedArray(layer.source.buffer);
				source = new ImageData(clamped, layer.width, layer.height);
			}

			if (source instanceof ImageBitmap) {
				ctx.drawImage(source, layer.x, layer.y, layer.width, layer.height);
			} else {
				ctx.putImageData(source, layer.x, layer.y);
			}

			ctx.restore();
		}

		const imageData = ctx.getImageData(0, 0, width, height);
		return new Uint8Array(imageData.data.buffer);
	},
};

// ---- Encode ---------------------------------------------------------------

const browserEncode: EncodeBackend = {
	async encode(params: EncodeParams): Promise<EncodeSession> {
		// Lazy-import mediabunny so tree-shaking works when Tauri is used
		const {
			Output,
			Mp4OutputFormat,
			WebMOutputFormat,
			BufferTarget,
			CanvasSource,
		} = await import("mediabunny");

		const outputFormat =
			params.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();
		const target = new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		const canvas = new OffscreenCanvas(params.width, params.height);
		const ctx = canvas.getContext("2d")!;

		const videoSource = new CanvasSource(canvas, {
			codec: params.format === "webm" ? "vp9" : "avc",
			bitrate: qualityToBitrate(params.quality),
		});

		output.addVideoTrack(videoSource, { frameRate: params.fps });

		await output.start();

		let cancelled = false;
		let frameCount = 0;

		return {
			async addFrame(frame: Uint8Array, timestampSeconds: number) {
				if (cancelled) return;
				const clamped = new Uint8ClampedArray(frame.buffer);
				const imageData = new ImageData(clamped, params.width, params.height);
				ctx.putImageData(imageData, 0, 0);
				await videoSource.add(timestampSeconds, 1 / params.fps);
				frameCount++;
			},

			async addAudio(pcm: Float32Array, sampleRate: number, channels: number) {
				if (cancelled) return;
				const { AudioBufferSource } = await import("mediabunny");
				const audioCodec = params.format === "webm" ? "opus" : "aac";
				const audioSource = new AudioBufferSource({
					codec: audioCodec,
					bitrate: qualityToBitrate(params.quality),
				});
				output.addAudioTrack(audioSource);

				// Build AudioBuffer from raw PCM
				const audioCtx = new OfflineAudioContext(
					channels,
					pcm.length / channels,
					sampleRate,
				);
				const buffer = audioCtx.createBuffer(
					channels,
					pcm.length / channels,
					sampleRate,
				);
				const samplesPerChannel = pcm.length / channels;
				for (let ch = 0; ch < channels; ch++) {
					const channelData = buffer.getChannelData(ch);
					for (let i = 0; i < samplesPerChannel; i++) {
						channelData[i] = pcm[i * channels + ch];
					}
				}

				await audioSource.add(buffer);
				audioSource.close();
			},

			async *finalize(): AsyncGenerator<ProgressEvent, Uint8Array> {
				if (cancelled) {
					yield { stage: "error", message: "Encode was cancelled" };
					return new Uint8Array(0);
				}

				yield { stage: "encoding", progress: 0.95 };

				videoSource.close();
				await output.finalize();

				yield { stage: "encoding", progress: 1 };
				yield { stage: "done" };

				const buffer = target.buffer;
				if (!buffer) {
					yield { stage: "error", message: "No output buffer produced" };
					return new Uint8Array(0);
				}

				return new Uint8Array(buffer);
			},

			cancel() {
				cancelled = true;
				void output.cancel();
			},
		};
	},
};

function qualityToBitrate(quality: string): number {
	const map: Record<string, number> = {
		low: 1_000_000,
		medium: 4_000_000,
		high: 8_000_000,
		very_high: 16_000_000,
	};
	return map[quality] ?? map.medium;
}

// ---- Decode ---------------------------------------------------------------

const browserDecode: DecodeBackend = {
	async probe(file) {
		const { Input, ALL_FORMATS, BlobSource } = await import("mediabunny");
		const blob = file instanceof File ? file : new Blob([file]);
		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			const audioTrack = await input.getPrimaryAudioTrack();

			return {
				duration: videoTrack?.duration ?? 0,
				width: videoTrack?.width ?? 0,
				height: videoTrack?.height ?? 0,
				fps: videoTrack?.frameRate ?? 0,
				hasAudio: audioTrack !== null,
				codec: videoTrack?.codec ?? "unknown",
			};
		} finally {
			input.dispose();
		}
	},

	async *decodeFrames({ file, startTime, endTime }) {
		const { Input, ALL_FORMATS, BlobSource, CanvasSink } =
			await import("mediabunny");
		const blob = file instanceof File ? file : new Blob([file]);
		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			input.dispose();
			return;
		}

		const sink = new CanvasSink(videoTrack, { poolSize: 3, fit: "contain" });

		try {
			for await (const frame of sink.canvases(startTime)) {
				if (endTime !== undefined && frame.timestamp > endTime) break;

				// Convert OffscreenCanvas → RGBA Uint8Array
				const canvas = frame.canvas as OffscreenCanvas;
				const ctx = canvas.getContext("2d")!;
				const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

				yield {
					data: new Uint8Array(imageData.data.buffer),
					width: canvas.width,
					height: canvas.height,
					timestamp: frame.timestamp,
				};
			}
		} finally {
			input.dispose();
		}
	},

	async getFrameAt({ file, time, width, height }) {
		const gen = browserDecode.decodeFrames({ file, startTime: time });
		const { value, done } = await gen.next();
		await gen.return(undefined as never); // cleanup

		if (done || !value) {
			throw new Error(`No frame found at time ${time}`);
		}

		// Resize if requested
		if (width && height && (value.width !== width || value.height !== height)) {
			const src = new OffscreenCanvas(value.width, value.height);
			const srcCtx = src.getContext("2d")!;
			const srcData = new ImageData(
				new Uint8ClampedArray(value.data.buffer),
				value.width,
				value.height,
			);
			srcCtx.putImageData(srcData, 0, 0);

			const dst = new OffscreenCanvas(width, height);
			const dstCtx = dst.getContext("2d")!;
			dstCtx.drawImage(src, 0, 0, width, height);
			const resized = dstCtx.getImageData(0, 0, width, height);

			return {
				data: new Uint8Array(resized.data.buffer),
				width,
				height,
				timestamp: value.timestamp,
			};
		}

		return value;
	},
};

// ---- File I/O -------------------------------------------------------------

const browserFileIO: FileIOBackend = {
	async readFile(path) {
		// In the browser, "path" is treated as a URL or blob URL.
		const response = await fetch(path);
		const buffer = await response.arrayBuffer();
		return new Uint8Array(buffer);
	},

	async writeFile(path, data) {
		// OPFS write
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(path, { create: true });
		const writable = await handle.createWritable();
		await writable.write(data);
		await writable.close();
	},

	async pickFile({ accept, multiple }) {
		try {
			const handles = await (window as any).showOpenFilePicker({
				multiple: multiple ?? false,
				types: accept?.length ? [{ accept: { "*/*": accept } }] : undefined,
			});

			return Promise.all(
				handles.map(
					async (handle: FileSystemFileHandle): Promise<FileHandle> => {
						const file = await handle.getFile();
						return {
							name: file.name,
							path: URL.createObjectURL(file),
							size: file.size,
							async read() {
								const buf = await file.arrayBuffer();
								return new Uint8Array(buf);
							},
							toFile() {
								return file;
							},
						};
					},
				),
			);
		} catch {
			return null; // User cancelled
		}
	},

	async pickSaveLocation({ defaultName, accept }) {
		try {
			const handle = await (window as any).showSaveFilePicker({
				suggestedName: defaultName,
				types: accept?.length ? [{ accept: { "*/*": accept } }] : undefined,
			});
			// Return a synthetic "path" — in browser we'll store the handle
			return handle.name;
		} catch {
			return null;
		}
	},

	async deleteFile(path) {
		try {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(path);
		} catch {
			// No-op if not found
		}
	},

	async exists(path) {
		try {
			const root = await navigator.storage.getDirectory();
			await root.getFileHandle(path);
			return true;
		} catch {
			return false;
		}
	},

	async getTempDir() {
		return "opfs://tmp";
	},
};

// ---- Audio ----------------------------------------------------------------

const browserAudio: AudioBackend = {
	async extractPeaks({ file, length }) {
		const blob = file instanceof File ? file : new Blob([file]);
		const arrayBuffer = await blob.arrayBuffer();
		const audioContext = new AudioContext();
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		await audioContext.close();

		const peaks: AudioPeaks = [];

		for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
			const data = audioBuffer.getChannelData(ch);
			const step = Math.floor(data.length / length);
			const channelPeaks: number[] = [];

			for (let i = 0; i < length; i++) {
				const start = i * step;
				const end = Math.min(start + step, data.length);
				let max = 0;
				for (let j = start; j < end; j++) {
					const abs = Math.abs(data[j]);
					if (abs > max) max = abs;
				}
				channelPeaks.push(max);
			}
			peaks.push(channelPeaks);
		}

		return peaks;
	},

	async decodeAudio({ file, sampleRate }) {
		const blob = file instanceof File ? file : new Blob([file]);
		const arrayBuffer = await blob.arrayBuffer();
		const targetRate = sampleRate ?? 44100;
		const audioContext = new AudioContext({ sampleRate: targetRate });
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		await audioContext.close();

		const pcm: Float32Array[] = [];
		for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
			pcm.push(new Float32Array(audioBuffer.getChannelData(ch)));
		}

		return {
			pcm,
			sampleRate: audioBuffer.sampleRate,
			channels: audioBuffer.numberOfChannels,
			duration: audioBuffer.duration,
		};
	},

	async *mixAudio({ clips, duration, sampleRate }) {
		const rate = sampleRate ?? 44100;
		const outputLength = Math.ceil(duration * rate);
		const outputChannels = 2;
		const output: Float32Array[] = Array.from(
			{ length: outputChannels },
			() => new Float32Array(outputLength),
		);

		yield { stage: "mixing", progress: 0 };

		for (let i = 0; i < clips.length; i++) {
			const clip = clips[i];
			if (clip.muted) continue;

			const outputStartSample = Math.floor(clip.startTime * rate);
			const sourceStartSample = Math.floor(clip.trimStart * clip.sampleRate);
			const clipSamples = Math.floor(clip.duration * clip.sampleRate);
			const resampleRatio = rate / clip.sampleRate;

			for (let ch = 0; ch < outputChannels; ch++) {
				const outData = output[ch];
				const srcData = clip.pcm[Math.min(ch, clip.pcm.length - 1)];

				const resampledLength = Math.floor(clipSamples * resampleRatio);

				for (let s = 0; s < resampledLength; s++) {
					const outIdx = outputStartSample + s;
					if (outIdx >= outputLength) break;

					const srcIdx = sourceStartSample + Math.floor(s / resampleRatio);
					if (srcIdx >= srcData.length) break;

					outData[outIdx] += srcData[srcIdx] * clip.volume;
				}
			}

			yield { stage: "mixing", progress: (i + 1) / clips.length };
		}

		yield { stage: "done" };
		return output;
	},
};

// ---- Factory --------------------------------------------------------------

export function createBrowserBackend(): EditorBackend {
	return {
		runtime: "browser",
		render: browserRender,
		encode: browserEncode,
		decode: browserDecode,
		fileIO: browserFileIO,
		audio: browserAudio,
	};
}
