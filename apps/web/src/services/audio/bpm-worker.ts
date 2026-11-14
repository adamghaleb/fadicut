export type BpmWorkerMessage = {
	type: "detect-bpm";
	channelData: Float32Array;
	sampleRate: number;
};

export type BpmWorkerResponse =
	| { type: "bpm-result"; bpm: number; confidence: number }
	| { type: "bpm-error"; error: string };

self.onmessage = (event: MessageEvent<BpmWorkerMessage>) => {
	const message = event.data;

	if (message.type === "detect-bpm") {
		try {
			const result = detectBpm({
				channelData: message.channelData,
				sampleRate: message.sampleRate,
			});
			self.postMessage({
				type: "bpm-result",
				bpm: result.bpm,
				confidence: result.confidence,
			} satisfies BpmWorkerResponse);
		} catch (error) {
			self.postMessage({
				type: "bpm-error",
				error: error instanceof Error ? error.message : "BPM detection failed",
			} satisfies BpmWorkerResponse);
		}
	}
};

const MIN_BPM = 60;
const MAX_BPM = 200;
const RMS_WINDOW = 1024;
const ONSET_THRESHOLD = 0.15;

function detectBpm({
	channelData,
	sampleRate,
}: {
	channelData: Float32Array;
	sampleRate: number;
}): { bpm: number; confidence: number } {
	// Step 1: Compute energy envelope (windowed RMS)
	const envelope = computeEnergyEnvelope({
		channelData,
		windowSize: RMS_WINDOW,
	});

	// Step 2: Detect onsets (peaks in energy derivative)
	const onsetTimes = detectOnsets({
		envelope,
		sampleRate,
		windowSize: RMS_WINDOW,
		threshold: ONSET_THRESHOLD,
	});

	if (onsetTimes.length < 4) {
		return { bpm: 120, confidence: 0 };
	}

	// Step 3: Compute inter-onset intervals
	const intervals: number[] = [];
	for (let i = 1; i < onsetTimes.length; i++) {
		intervals.push(onsetTimes[i] - onsetTimes[i - 1]);
	}

	// Step 4: Autocorrelation on intervals to find dominant periodicity
	const { bpm, confidence } = findDominantBpm({
		intervals,
		minBpm: MIN_BPM,
		maxBpm: MAX_BPM,
	});

	return { bpm: Math.round(bpm), confidence };
}

function computeEnergyEnvelope({
	channelData,
	windowSize,
}: {
	channelData: Float32Array;
	windowSize: number;
}): Float32Array {
	const numWindows = Math.floor(channelData.length / windowSize);
	const envelope = new Float32Array(numWindows);

	for (let i = 0; i < numWindows; i++) {
		const start = i * windowSize;
		let sum = 0;
		for (let j = start; j < start + windowSize; j++) {
			sum += channelData[j] * channelData[j];
		}
		envelope[i] = Math.sqrt(sum / windowSize);
	}

	return envelope;
}

function detectOnsets({
	envelope,
	sampleRate,
	windowSize,
	threshold,
}: {
	envelope: Float32Array;
	sampleRate: number;
	windowSize: number;
	threshold: number;
}): number[] {
	const onsetTimes: number[] = [];
	const secondsPerWindow = windowSize / sampleRate;

	// Compute derivative of energy envelope
	const derivative = new Float32Array(envelope.length - 1);
	for (let i = 0; i < derivative.length; i++) {
		derivative[i] = envelope[i + 1] - envelope[i];
	}

	// Adaptive threshold: use mean + factor * stddev of positive derivatives
	let positiveSum = 0;
	let positiveCount = 0;
	for (let i = 0; i < derivative.length; i++) {
		if (derivative[i] > 0) {
			positiveSum += derivative[i];
			positiveCount++;
		}
	}

	const meanPositive = positiveCount > 0 ? positiveSum / positiveCount : 0;
	const adaptiveThreshold = Math.max(threshold * meanPositive, 0.001);

	// Find peaks in derivative above threshold
	const minOnsetGap = 0.05; // 50ms minimum gap between onsets
	let lastOnsetTime = -minOnsetGap;

	for (let i = 1; i < derivative.length - 1; i++) {
		if (
			derivative[i] > adaptiveThreshold &&
			derivative[i] > derivative[i - 1] &&
			derivative[i] >= derivative[i + 1]
		) {
			const time = (i + 1) * secondsPerWindow;
			if (time - lastOnsetTime >= minOnsetGap) {
				onsetTimes.push(time);
				lastOnsetTime = time;
			}
		}
	}

	return onsetTimes;
}

function findDominantBpm({
	intervals,
	minBpm,
	maxBpm,
}: {
	intervals: number[];
	minBpm: number;
	maxBpm: number;
}): { bpm: number; confidence: number } {
	const minInterval = 60 / maxBpm;
	const maxInterval = 60 / minBpm;

	// Build a histogram of BPM candidates using interval clustering
	const bpmResolution = 0.5;
	const numBins = Math.ceil((maxBpm - minBpm) / bpmResolution);
	const histogram = new Float32Array(numBins);

	for (const interval of intervals) {
		if (interval < minInterval || interval > maxInterval) continue;

		// Check integer multiples and subdivisions (1x, 2x, 0.5x)
		for (const multiplier of [1, 2, 0.5]) {
			const adjustedInterval = interval * multiplier;
			if (adjustedInterval < minInterval || adjustedInterval > maxInterval)
				continue;

			const bpm = 60 / adjustedInterval;
			const binIndex = Math.round((bpm - minBpm) / bpmResolution);
			if (binIndex >= 0 && binIndex < numBins) {
				// Weight by inverse of multiplier distance from 1
				const weight = multiplier === 1 ? 1 : 0.5;
				histogram[binIndex] += weight;
			}
		}
	}

	// Smooth histogram with a small gaussian kernel
	const smoothed = new Float32Array(numBins);
	const kernelRadius = 2;
	for (let i = 0; i < numBins; i++) {
		let sum = 0;
		let weightSum = 0;
		for (let j = -kernelRadius; j <= kernelRadius; j++) {
			const idx = i + j;
			if (idx >= 0 && idx < numBins) {
				const weight = Math.exp(-(j * j) / 2);
				sum += histogram[idx] * weight;
				weightSum += weight;
			}
		}
		smoothed[i] = sum / weightSum;
	}

	// Find peak in smoothed histogram
	let peakBin = 0;
	let peakValue = 0;
	for (let i = 0; i < numBins; i++) {
		if (smoothed[i] > peakValue) {
			peakValue = smoothed[i];
			peakBin = i;
		}
	}

	const bpm = minBpm + peakBin * bpmResolution;

	// Confidence: ratio of peak to total energy
	let totalEnergy = 0;
	for (let i = 0; i < numBins; i++) {
		totalEnergy += smoothed[i];
	}
	const confidence =
		totalEnergy > 0 ? Math.min((peakValue / totalEnergy) * 3, 1) : 0;

	return { bpm, confidence };
}
