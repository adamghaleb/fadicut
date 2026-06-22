/**
 * Batch D — Fadi grade + speed-ramp effect panels (issue #4).
 *
 * Mountable, store-agnostic panels for the two native-baked effects this batch owns.
 * The integrator wires these into the properties panel's effect list; each takes the
 * current params + an onChange and renders a browser preview that matches the native
 * bake (bridge/render/{fadi_grade,speedramp}.py) from the SAME params.
 *
 *   import { GradeEffectPanel, RampEffectPanel } from ".../fadi/effects";
 *
 * Param shapes + Bridge-payload serializers live in ./types; previews in
 * ./grade-preview (WebGL) and ./ramp-preview (canvas).
 */

export {
	GradeEffectPanel,
	default as GradeEffectPanelDefault,
} from "./grade-effect";
export type { GradeEffectPanelProps } from "./grade-effect";

export {
	RampEffectPanel,
	default as RampEffectPanelDefault,
} from "./ramp-effect";
export type { RampEffectPanelProps } from "./ramp-effect";

export {
	FADI_PALETTE,
	SIGNATURE_CURVE,
	defaultGradeEffect,
	defaultRampEffect,
	gradeToBridgePayload,
	rampToBridgePayload,
} from "./types";
export type {
	GradeEffectParams,
	GradeMode,
	RampEffectParams,
	RampMode,
	BezierCurve,
	MotionBlurParams,
} from "./types";

export { createGradePreview } from "./grade-preview";
export type { GradePreview } from "./grade-preview";
export { drawRampProfile, bezierYAt } from "./ramp-preview";
