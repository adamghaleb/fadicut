/**
 * Canvas preview of a speed ramp's velocity profile (engine: speedramp).
 *
 * The ramp is a temporal effect — there's no single still to show — so the browser
 * preview is the *speed-over-time curve* the native baker will follow: the signature
 * bezier easing INTO terminal velocity, the cut one frame before terminal, and (for
 * transit) the mirrored ramp-down on clip B. This makes the editor legible without
 * decoding video; the authoritative motion is baked by bridge/render/speedramp.py.
 */

import type { BezierCurve, RampMode } from "./types";

/** Evaluate a cubic-bezier ease(x)→y (Newton on x, then eval y). Mirrors speedramp.py. */
export function bezierYAt(t: number, c: BezierCurve, iters = 24): number {
	const [p1x, p1y, p2x, p2y] = c;
	const cx = (u: number) =>
		3 * (1 - u) ** 2 * u * p1x + 3 * (1 - u) * u * u * p2x + u ** 3;
	const cy = (u: number) =>
		3 * (1 - u) ** 2 * u * p1y + 3 * (1 - u) * u * u * p2y + u ** 3;
	let u = t;
	for (let i = 0; i < iters; i++) {
		const x = cx(u) - t;
		const dx = (cx(u + 1e-4) - cx(u - 1e-4)) / 2e-4;
		if (Math.abs(dx) < 1e-7) break;
		u -= x / dx;
		u = Math.min(1, Math.max(0, u));
	}
	return Math.min(1, Math.max(0, cy(u)));
}

/** Position-along-source for a normalized progress p, given mode + curve. */
function easeForMode(mode: RampMode, c: BezierCurve): (p: number) => number {
	if (mode === "up") return (p) => bezierYAt(p, [0.55, 0.0, 1.0, 0.45]);
	if (mode === "down") return (p) => bezierYAt(p, [0.0, 0.55, 0.45, 1.0]);
	// whoosh / transit segments use the full signature curve
	return (p) => bezierYAt(p, c);
}

/**
 * Paint the velocity profile (speed = d/dt of the eased position) onto a 2D canvas.
 * `targetRate` scales the peak; the dashed vertical marks the "cut one frame before
 * terminal" point.
 */
export function drawRampProfile(
	canvas: HTMLCanvasElement,
	opts: { mode: RampMode; curve: BezierCurve; targetRate: number },
): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const W = canvas.width;
	const H = canvas.height;
	ctx.clearRect(0, 0, W, H);

	const pad = 10;
	const ease = easeForMode(opts.mode, opts.curve);
	const N = 120;

	// sample speed = local derivative of position, normalized then scaled to targetRate
	const speeds: number[] = [];
	let maxS = 1e-6;
	for (let i = 0; i < N; i++) {
		const p = i / (N - 1);
		const dp = 1 / N;
		const s = Math.abs(ease(Math.min(1, p + dp)) - ease(Math.max(0, p - dp)));
		speeds.push(s);
		if (s > maxS) maxS = s;
	}
	const peak = Math.max(1, opts.targetRate);

	// grid baseline
	ctx.strokeStyle = "rgba(255,255,255,0.12)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(pad, H - pad);
	ctx.lineTo(W - pad, H - pad);
	ctx.stroke();

	// profile
	ctx.strokeStyle = "#05D3FF";
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (let i = 0; i < N; i++) {
		const x = pad + ((W - 2 * pad) * i) / (N - 1);
		const norm = speeds[i] / maxS; // 0..1
		const v = 1 + (peak - 1) * norm; // 1..peak
		const y = H - pad - ((H - 2 * pad) * (v - 1)) / (peak - 1 || 1);
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.stroke();

	// "cut one frame before terminal" marker (near the speed peak)
	let peakIdx = 0;
	for (let i = 1; i < N; i++) if (speeds[i] > speeds[peakIdx]) peakIdx = i;
	const cutIdx = Math.max(0, peakIdx - 1);
	const cx = pad + ((W - 2 * pad) * cutIdx) / (N - 1);
	ctx.strokeStyle = "#FF0060";
	ctx.setLineDash([4, 3]);
	ctx.beginPath();
	ctx.moveTo(cx, pad);
	ctx.lineTo(cx, H - pad);
	ctx.stroke();
	ctx.setLineDash([]);

	// label
	ctx.fillStyle = "rgba(255,255,255,0.6)";
	ctx.font = "10px monospace";
	ctx.fillText(`${opts.mode}  peak ${peak.toFixed(1)}×`, pad + 2, pad + 10);
}
