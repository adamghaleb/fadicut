"use client";

/**
 * MicrographicsEffect panel — the editor UI for the Fadi micrographics treatment
 * (engine: fadi_micrographics). The FadiFiles "micrographics on every image" rule:
 * hairline readouts, registration corner marks, micro counters and tick strips composited
 * over a clip so it reads as a data-dense Hermetic artifact.
 *
 * Mountable, store-agnostic: pass the current MicrographicsEffectParams + an onChange.
 * The parent owns state and persists it into FadiElement.effects. Maps 1:1 onto the FROZEN
 * contract MicrographicsEffect (density / palette / seed / params); the native baker
 * (bridge/render/micrographics.py) reads the same shape.
 *
 * Wire into a properties tab with:
 *   <MicrographicsEffectPanel value={effect} onChange={setEffect} />
 */

import {
	Section,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
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
	FADI_PALETTE,
	type MicrographicsDensity,
	type MicrographicsEffectParams,
	type MicrographicsTint,
	defaultMicrographicsEffect,
} from "./types";

const DENSITY_OPTIONS: { value: MicrographicsDensity; label: string }[] = [
	{ value: "sparse", label: "Sparse (1 panel)" },
	{ value: "medium", label: "Medium (2 panels)" },
	{ value: "dense", label: "Dense (4 panels)" },
];

const TINT_OPTIONS: { value: MicrographicsTint | "auto"; label: string }[] = [
	{ value: "auto", label: "Auto (per-panel)" },
	{ value: "fadi", label: "Single Fadi color" },
	{ value: "rainbow-3s", label: "Rainbow cycle" },
	{ value: "black", label: "Black linework" },
	{ value: "white", label: "White linework" },
];

export interface MicrographicsEffectPanelProps {
	value?: MicrographicsEffectParams;
	onChange: (next: MicrographicsEffectParams) => void;
	className?: string;
}

export function MicrographicsEffectPanel({
	value,
	onChange,
	className,
}: MicrographicsEffectPanelProps) {
	const effect = value ?? defaultMicrographicsEffect();

	const patch = (p: Partial<MicrographicsEffectParams>) =>
		onChange({ ...effect, ...p });
	const patchParams = (p: Partial<MicrographicsEffectParams["params"]>) =>
		onChange({ ...effect, params: { ...effect.params, ...p } });

	const palette = effect.palette ?? [];
	const togglePaletteColor = (hex: string) => {
		const has = palette.some((c) => c.toUpperCase() === hex.toUpperCase());
		const next = has
			? palette.filter((c) => c.toUpperCase() !== hex.toUpperCase())
			: [...palette, hex];
		patch({ palette: next });
	};

	const tintValue = effect.params.tint ?? "auto";

	return (
		<div className={cn("flex flex-col", className)}>
			<Section sectionKey="fadi-micrographics">
				<SectionHeader>
					<SectionTitle>Fadi Micrographics</SectionTitle>
				</SectionHeader>
				<SectionFields className="p-4 pt-3">
					<SectionField label="Density">
						<Select
							value={effect.density}
							onValueChange={(v) =>
								patch({ density: v as MicrographicsDensity })
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DENSITY_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Tint">
						<Select
							value={tintValue}
							onValueChange={(v) =>
								patchParams({
									tint: v === "auto" ? undefined : (v as MicrographicsTint),
								})
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TINT_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Palette">
						<div className="flex gap-1.5">
							{FADI_PALETTE.map((hex) => {
								const active = palette.some(
									(c) => c.toUpperCase() === hex.toUpperCase(),
								);
								return (
									<button
										key={hex}
										type="button"
										title={hex}
										onClick={() => togglePaletteColor(hex)}
										className={cn(
											"size-5 rounded-full border-2",
											active ? "border-foreground" : "border-transparent",
										)}
										style={{ backgroundColor: hex }}
									/>
								);
							})}
						</div>
					</SectionField>

					<SectionField label={`Seed ${effect.seed ?? 7}`}>
						<Slider
							min={0}
							max={999}
							step={1}
							value={[effect.seed ?? 7]}
							onValueChange={([v]) => patch({ seed: v })}
						/>
					</SectionField>
				</SectionFields>
			</Section>
		</div>
	);
}

export default MicrographicsEffectPanel;
