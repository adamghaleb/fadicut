import type { BpmWorkerMessage, BpmWorkerResponse } from "./bpm-worker";

let worker: Worker | null = null;

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./bpm-worker.ts", import.meta.url), {
			type: "module",
		});
	}
	return worker;
}

export function detectBpmAsync({
	buffer,
}: {
	buffer: AudioBuffer;
}): Promise<{ bpm: number; confidence: number }> {
	return new Promise((resolve, reject) => {
		const w = getWorker();

		// Merge channels to mono
		const length = buffer.length;
		const mono = new Float32Array(length);
		const numChannels = buffer.numberOfChannels;

		for (let c = 0; c < numChannels; c++) {
			const channelData = buffer.getChannelData(c);
			for (let i = 0; i < length; i++) {
				mono[i] += channelData[i];
			}
		}

		if (numChannels > 1) {
			for (let i = 0; i < length; i++) {
				mono[i] /= numChannels;
			}
		}

		const handler = (event: MessageEvent<BpmWorkerResponse>) => {
			w.removeEventListener("message", handler);
			if (event.data.type === "bpm-result") {
				resolve({ bpm: event.data.bpm, confidence: event.data.confidence });
			} else {
				reject(new Error(event.data.error));
			}
		};

		w.addEventListener("message", handler);
		w.postMessage(
			{
				type: "detect-bpm",
				channelData: mono,
				sampleRate: buffer.sampleRate,
			} satisfies BpmWorkerMessage,
			[mono.buffer],
		);
	});
}
