/**
 * Editor-side mirror of the Fadi effect params (Batch D: grade + ramp).
 *
 * These are the TS shapes for the two FadiEffect variants this batch owns, kept in
 * lock-step with the FROZEN Python contract at
 *   contracts/fadi_contracts/fadi_edl.py  → GradeEffect, RampEffect, BezierCurve, MotionBlur
 *
 * The contract is the source of truth; when codegen.py emits real TS types into
 * src/fadi/contracts, swap these local types for the generated ones. Until then these
 * stand in so the panels compile and the integrator has a stable shape to wire.
 *
 * All editor params are plain JSON — the browser preview reads them directly and the
 * Bridge baker (bridge/render/{fadi_grade,speedramp}.py) reads the same shape.
 */

// ── grade (engine: fadi_grade) ───────────────────────────────────────────────

export type GradeMode =
	| "hls_substitution"
	| "rainbow"
	| "hue_shift"
	| "outline";

export interface GradeEffectParams {
	type: "grade";
	engine: "fadi_grade";
	mode: GradeMode;
	/** Hex of the Fadi color to substitute (single-color modes). */
	fadiColor?: string | null;
	preset?: string | null;
	/** Free-form knobs the grade script understands. */
	params: {
		/** Palette cycle cadence (rainbow). */
		everyNFrames?: number;
		/** Subject-key thresholds (hls_substitution / outline). */
		satThreshold?: number;
		valThreshold?: number;
		maskSoft?: number;
		/** Hue rotation in degrees (hue_shift). */
		hueDeg?: number;
		[k: string]: number | string | boolean | undefined;
	};
}

/** The 7 Fadi brand colors, canonical order — matches FADI_RGB in fadi_grade.py. */
export const FADI_PALETTE = [
	"#FF0060",
	"#FFA405",
	"#FFE400",
	"#11FF05",
	"#05D3FF",
	"#6F05FF",
	"#F605FF",
] as const;

export function defaultGradeEffect(): GradeEffectParams {
	return {
		type: "grade",
		engine: "fadi_grade",
		mode: "hls_substitution",
		fadiColor: FADI_PALETTE[4], // cyan
		preset: null,
		params: {
			everyNFrames: 3,
			satThreshold: 0.18,
			valThreshold: 0.22,
			maskSoft: 0.08,
			hueDeg: 60,
		},
	};
}

// ── ramp (engine: speedramp) ─────────────────────────────────────────────────

export type RampMode = "whoosh" | "up" | "down" | "transit";

/** Cubic-bezier control points; default = Adam's signature easing curve. */
export type BezierCurve = [number, number, number, number];
export const SIGNATURE_CURVE: BezierCurve = [0.765, 0.0, 0.106, 1.0];

export interface MotionBlurParams {
	shutterDeg: number;
	samples: number;
	intensity: number;
}

export interface RampEffectParams {
	type: "ramp";
	engine: "speedramp";
	mode: RampMode;
	curve: BezierCurve;
	/** Peak speed multiplier at terminal velocity. */
	targetRate?: number | null;
	useRife: boolean;
	motionBlur: MotionBlurParams;
}

export function defaultRampEffect(): RampEffectParams {
	return {
		type: "ramp",
		engine: "speedramp",
		mode: "whoosh",
		curve: [...SIGNATURE_CURVE],
		targetRate: 15,
		useRife: true,
		motionBlur: { shutterDeg: 360, samples: 36, intensity: 1.75 },
	};
}

/**
 * Serialize a RampEffectParams into the Bridge `render_ramp` job payload shape.
 * (camelCase editor params → snake_case contract/payload, with window targeting.)
 */
export function rampToBridgePayload(
	r: RampEffectParams,
	io: { src: string | string[]; out?: string; at?: number; span?: number },
) {
	return {
		clips: io.src,
		out: io.out,
		mode: r.mode,
		target_rate: r.targetRate ?? null,
		use_rife: r.useRife,
		motion_blur: {
			shutter_deg: r.motionBlur.shutterDeg,
			samples: r.motionBlur.samples,
			intensity: r.motionBlur.intensity,
		},
		at: io.at,
		span: io.span,
	};
}

/** Serialize a GradeEffectParams into the Bridge `render_grade` job payload shape. */
export function gradeToBridgePayload(
	g: GradeEffectParams,
	io: { src: string; out?: string; fps?: number; width?: number },
) {
	return {
		src: io.src,
		out: io.out,
		mode: g.mode,
		fadi_color: g.fadiColor ?? null,
		params: {
			every_n_frames: g.params.everyNFrames,
			sat_threshold: g.params.satThreshold,
			val_threshold: g.params.valThreshold,
			mask_soft: g.params.maskSoft,
			hue_deg: g.params.hueDeg,
		},
		fps: io.fps,
		width: io.width,
	};
}
