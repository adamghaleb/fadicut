"use client";

/**
 * RampEffect panel — the editor UI for the Fadi speed ramp (engine: speedramp).
 *
 * Mountable, store-agnostic: pass the current RampEffectParams + onChange. Shows the
 * velocity-profile preview (ramp-preview.ts) — the signature-bezier ramp into terminal
 * velocity, with the "cut one frame before terminal" marker — and the param controls.
 * The native baker (bridge/render/speedramp.py) follows the same params.
 *
 * Wire into a properties tab with:
 *   <RampEffectPanel value={effect} onChange={setEffect} />
 */

import { useEffect, useRef } from "react";
import {
	Section,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/ui";
import {
	SIGNATURE_CURVE,
	type RampEffectParams,
	type RampMode,
	defaultRampEffect,
} from "./types";
import { drawRampProfile } from "./ramp-preview";

const MODE_OPTIONS: { value: RampMode; label: string }[] = [
	{ value: "whoosh", label: "Whoosh (fly-past)" },
	{ value: "up", label: "Ramp Up (into cut)" },
	{ value: "down", label: "Ramp Down (out of cut)" },
	{ value: "transit", label: "Transit (A→cut→B)" },
];

export interface RampEffectPanelProps {
	value?: RampEffectParams;
	onChange: (next: RampEffectParams) => void;
	className?: string;
}

export function RampEffectPanel({
	value,
	onChange,
	className,
}: RampEffectPanelProps) {
	const effect = value ?? defaultRampEffect();
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		drawRampProfile(canvas, {
			mode: effect.mode,
			curve: effect.curve ?? SIGNATURE_CURVE,
			targetRate: effect.targetRate ?? 15,
		});
	}, [effect.mode, effect.curve, effect.targetRate]);

	const patch = (p: Partial<RampEffectParams>) => onChange({ ...effect, ...p });
	const patchBlur = (p: Partial<RampEffectParams["motionBlur"]>) =>
		onChange({ ...effect, motionBlur: { ...effect.motionBlur, ...p } });

	const usesSignature =
		(effect.curve ?? SIGNATURE_CURVE).join(",") === SIGNATURE_CURVE.join(",");

	return (
		<div className={cn("flex flex-col", className)}>
			<canvas
				ref={canvasRef}
				width={320}
				height={140}
				className="bg-accent/40 w-full rounded-md"
			/>

			<Section sectionKey="fadi-ramp">
				<SectionHeader>
					<SectionTitle>Speed Ramp</SectionTitle>
				</SectionHeader>
				<SectionFields className="p-4 pt-3">
					<SectionField label="Mode">
						<Select
							value={effect.mode}
							onValueChange={(v) => patch({ mode: v as RampMode })}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{MODE_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField
						label={`Terminal velocity ${(effect.targetRate ?? 15).toFixed(1)}×`}
					>
						<Slider
							min={1}
							max={30}
							step={0.5}
							value={[effect.targetRate ?? 15]}
							onValueChange={([v]) => patch({ targetRate: v })}
						/>
					</SectionField>

					<SectionField label="RIFE interpolation (M2 GPU)">
						<Switch
							checked={effect.useRife}
							onCheckedChange={(c) => patch({ useRife: c })}
						/>
					</SectionField>

					<SectionField
						label={`Motion blur ${effect.motionBlur.intensity.toFixed(2)}×`}
					>
						<Slider
							min={0}
							max={3}
							step={0.05}
							value={[effect.motionBlur.intensity]}
							onValueChange={([v]) => patchBlur({ intensity: v })}
						/>
					</SectionField>

					<SectionField label={`Blur samples ${effect.motionBlur.samples}`}>
						<Slider
							min={1}
							max={48}
							step={1}
							value={[effect.motionBlur.samples]}
							onValueChange={([v]) => patchBlur({ samples: v })}
						/>
					</SectionField>

					<SectionField label="Easing curve">
						<button
							type="button"
							onClick={() => patch({ curve: [...SIGNATURE_CURVE] })}
							className={cn(
								"border-input bg-accent rounded-md border px-3 py-1.5 text-xs",
								usesSignature && "text-muted-foreground",
							)}
						>
							{usesSignature
								? "Signature curve (0.765, 0, 0.106, 1)"
								: "Reset to signature curve"}
						</button>
					</SectionField>
				</SectionFields>
			</Section>
		</div>
	);
}

export default RampEffectPanel;
