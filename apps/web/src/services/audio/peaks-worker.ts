export type PeaksWorkerMessage = {
	type: "extract-peaks";
	channels: Float32Array[];
	length: number;
};

export type PeaksWorkerResponse =
	| { type: "peaks-result"; peaks: number[][] }
	| { type: "peaks-error"; error: string };

self.onmessage = (event: MessageEvent<PeaksWorkerMessage>) => {
	const message = event.data;

	if (message.type === "extract-peaks") {
		try {
			const peaks = computePeaks({
				channels: message.channels,
				length: message.length,
			});
			self.postMessage({
				type: "peaks-result",
				peaks,
			} satisfies PeaksWorkerResponse);
		} catch (error) {
			self.postMessage({
				type: "peaks-error",
				error:
					error instanceof Error ? error.message : "Peak extraction failed",
			} satisfies PeaksWorkerResponse);
		}
	}
};

function computePeaks({
	channels,
	length,
}: {
	channels: Float32Array[];
	length: number;
}): number[][] {
	const peaks: number[][] = [];

	for (const data of channels) {
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
}
