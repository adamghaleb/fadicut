"use client";

/**
 * GradeEffect panel — the editor UI for the Fadi grade (engine: fadi_grade).
 *
 * Mountable, self-contained: pass the current GradeEffectParams + an onChange, and an
 * optional preview <source> (image/video element or an already-painted frame canvas).
 * It renders the WebGL preview (grade-preview.ts, same HLS math as the native baker)
 * and the param controls. No store coupling — the parent owns state and persists it
 * into FadiElement.effects.
 *
 * Wire into a properties tab with:
 *   <GradeEffectPanel value={effect} onChange={setEffect} previewSource={frameEl} />
 */

import { useEffect, useRef } from "react";
import {
	Section,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Slider } from "@/components/ui/slider";
import { ColorPicker } from "@/components/ui/color-picker";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/ui";
import {
	FADI_PALETTE,
	type GradeEffectParams,
	type GradeMode,
	defaultGradeEffect,
} from "./types";
import { createGradePreview, type GradePreview } from "./grade-preview";

const MODE_OPTIONS: { value: GradeMode; label: string }[] = [
	{ value: "hls_substitution", label: "HLS Substitution" },
	{ value: "rainbow", label: "Rainbow Cycle" },
	{ value: "hue_shift", label: "Hue Shift" },
	{ value: "outline", label: "Outline (white + stroke)" },
];

export interface GradeEffectPanelProps {
	value?: GradeEffectParams;
	onChange: (next: GradeEffectParams) => void;
	/** A frame to preview the grade on (video frame canvas, <img>, or <video>). */
	previewSource?: TexImageSource | null;
	/** Frame index for the rainbow palette cycle preview. */
	frameIndex?: number;
	className?: string;
}

export function GradeEffectPanel({
	value,
	onChange,
	previewSource,
	frameIndex = 0,
	className,
}: GradeEffectPanelProps) {
	const effect = value ?? defaultGradeEffect();
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const previewRef = useRef<GradePreview | null>(null);

	// init / teardown the WebGL preview
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		try {
			previewRef.current = createGradePreview(canvas);
		} catch {
			previewRef.current = null; // WebGL2 unavailable — panel still works, no preview
		}
		return () => {
			previewRef.current?.dispose();
			previewRef.current = null;
		};
	}, []);

	// repaint when source or params change
	useEffect(() => {
		const preview = previewRef.current;
		if (!preview || !previewSource) return;
		preview.setSource(previewSource);
		preview.render(effect, frameIndex);
	}, [previewSource, effect, frameIndex]);

	const patch = (p: Partial<GradeEffectParams>) =>
		onChange({ ...effect, ...p });
	const patchParams = (p: Partial<GradeEffectParams["params"]>) =>
		onChange({ ...effect, params: { ...effect.params, ...p } });

	const isSingleColor =
		effect.mode === "hls_substitution" ||
		effect.mode === "rainbow" ||
		effect.mode === "outline";

	return (
		<div className={cn("flex flex-col", className)}>
			<canvas
				ref={canvasRef}
				width={320}
				height={180}
				className="bg-accent/40 aspect-video w-full rounded-md"
			/>

			<Section sectionKey="fadi-grade">
				<SectionHeader>
					<SectionTitle>Fadi Grade</SectionTitle>
				</SectionHeader>
				<SectionFields className="p-4 pt-3">
					<SectionField label="Mode">
						<Select
							value={effect.mode}
							onValueChange={(v) => patch({ mode: v as GradeMode })}
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

					{isSingleColor && effect.mode !== "rainbow" && (
						<SectionField label="Fadi Color">
							<div className="flex flex-col gap-2">
								<ColorPicker
									value={(effect.fadiColor ?? FADI_PALETTE[4])
										.replace(/^#/, "")
										.toUpperCase()}
									onChange={(c) => patch({ fadiColor: `#${c}` })}
									onChangeEnd={(c) => patch({ fadiColor: `#${c}` })}
								/>
								<div className="flex gap-1.5">
									{FADI_PALETTE.map((hex) => (
										<button
											key={hex}
											type="button"
											title={hex}
											onClick={() => patch({ fadiColor: hex })}
											className={cn(
												"size-5 rounded-full border",
												effect.fadiColor?.toUpperCase() === hex
													? "border-foreground"
													: "border-transparent",
											)}
											style={{ backgroundColor: hex }}
										/>
									))}
								</div>
							</div>
						</SectionField>
					)}

					{effect.mode === "rainbow" && (
						<SectionField
							label={`Cycle every ${effect.params.everyNFrames ?? 3} frames`}
						>
							<Slider
								min={1}
								max={12}
								step={1}
								value={[effect.params.everyNFrames ?? 3]}
								onValueChange={([v]) => patchParams({ everyNFrames: v })}
							/>
						</SectionField>
					)}

					{effect.mode === "hue_shift" && (
						<SectionField
							label={`Hue shift ${Math.round(effect.params.hueDeg ?? 60)}°`}
						>
							<Slider
								min={0}
								max={360}
								step={1}
								value={[effect.params.hueDeg ?? 60]}
								onValueChange={([v]) => patchParams({ hueDeg: v })}
							/>
						</SectionField>
					)}

					{(effect.mode === "hls_substitution" ||
						effect.mode === "outline") && (
						<>
							<SectionField
								label={`Subject saturation ≥ ${(effect.params.satThreshold ?? 0.18).toFixed(2)}`}
							>
								<Slider
									min={0}
									max={1}
									step={0.01}
									value={[effect.params.satThreshold ?? 0.18]}
									onValueChange={([v]) => patchParams({ satThreshold: v })}
								/>
							</SectionField>
							<SectionField
								label={`Subject value ≥ ${(effect.params.valThreshold ?? 0.22).toFixed(2)}`}
							>
								<Slider
									min={0}
									max={1}
									step={0.01}
									value={[effect.params.valThreshold ?? 0.22]}
									onValueChange={([v]) => patchParams({ valThreshold: v })}
								/>
							</SectionField>
							<SectionField
								label={`Mask softness ${(effect.params.maskSoft ?? 0.08).toFixed(2)}`}
							>
								<Slider
									min={0}
									max={0.4}
									step={0.01}
									value={[effect.params.maskSoft ?? 0.08]}
									onValueChange={([v]) => patchParams({ maskSoft: v })}
								/>
							</SectionField>
						</>
					)}
				</SectionFields>
			</Section>
		</div>
	);
}

export default GradeEffectPanel;
