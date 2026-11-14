import type { PeaksWorkerMessage, PeaksWorkerResponse } from "./peaks-worker";

let worker: Worker | null = null;

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./peaks-worker.ts", import.meta.url), {
			type: "module",
		});
	}
	return worker;
}

export function extractPeaksAsync({
	buffer,
	length = 512,
}: {
	buffer: AudioBuffer;
	length?: number;
}): Promise<number[][]> {
	return new Promise((resolve, reject) => {
		const w = getWorker();

		const channels: Float32Array[] = [];
		const transferables: ArrayBuffer[] = [];
		for (let c = 0; c < buffer.numberOfChannels; c++) {
			const copy = new Float32Array(buffer.getChannelData(c));
			channels.push(copy);
			transferables.push(copy.buffer);
		}

		const handler = (event: MessageEvent<PeaksWorkerResponse>) => {
			w.removeEventListener("message", handler);
			if (event.data.type === "peaks-result") {
				resolve(event.data.peaks);
			} else {
				reject(new Error(event.data.error));
			}
		};

		w.addEventListener("message", handler);
		w.postMessage(
			{
				type: "extract-peaks",
				channels,
				length,
			} satisfies PeaksWorkerMessage,
			transferables,
		);
	});
}
