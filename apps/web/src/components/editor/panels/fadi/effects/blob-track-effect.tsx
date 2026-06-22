"use client";

/**
 * BlobTrackEffect panel — the editor UI for the Fadi square blob-tracking treatment
 * (engine: fadi_blob_track, issue #10).
 *
 * Mountable, store-agnostic: pass the current BlobTrackEffectParams + an onChange. The
 * native baker (bridge/render/blob_track.py) reads the SAME params — it tracks feature
 * points (Shi-Tomasi + LK optical flow), draws numbered square micrographic reticles +
 * a bbox cage + telemetry HUD that ride the subject, beat-synced, then composites the
 * transparent pass over the clip.
 *
 * No store coupling — the parent owns state and persists it into FadiElement.effects.
 * The integrator mounts this in the Fadi FX tab (do NOT edit fadi-fx-tab.tsx here).
 *
 * Wire into a properties tab with:
 *   <BlobTrackEffectPanel value={effect} onChange={setEffect} />
 */

import {
	Section,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Switch } from "@/components/ui/switch";
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
	type BlobFollow,
	type BlobShape,
	type BlobTrackEffectParams,
	defaultBlobTrackEffect,
} from "./types";

const FOLLOW_OPTIONS: { value: BlobFollow; label: string }[] = [
	{ value: "subject", label: "Subject (telemetry + bbox cage)" },
	{ value: "center", label: "Center (proximity quad)" },
	{ value: "motion", label: "Motion (trails)" },
];

const SHAPE_OPTIONS: { value: BlobShape; label: string }[] = [
	{ value: "square", label: "Square reticle" },
	{ value: "rounded", label: "Rounded" },
	{ value: "circle", label: "Circle" },
];

export interface BlobTrackEffectPanelProps {
	value?: BlobTrackEffectParams;
	onChange: (next: BlobTrackEffectParams) => void;
	className?: string;
}

export function BlobTrackEffectPanel({
	value,
	onChange,
	className,
}: BlobTrackEffectPanelProps) {
	const effect = value ?? defaultBlobTrackEffect();

	const patch = (p: Partial<BlobTrackEffectParams>) =>
		onChange({ ...effect, ...p });
	const patchParams = (p: Partial<BlobTrackEffectParams["params"]>) =>
		onChange({ ...effect, params: { ...effect.params, ...p } });

	const maxFeatures = effect.params.maxFeatures ?? 140;
	const maxReticles = effect.params.maxReticles ?? 26;
	const tinted = !!effect.color;

	return (
		<div className={cn("flex flex-col", className)}>
			<Section sectionKey="fadi-blob-track">
				<SectionHeader>
					<SectionTitle>Blob Tracking</SectionTitle>
				</SectionHeader>
				<SectionFields className="p-4 pt-3">
					<SectionField label="Follow">
						<Select
							value={effect.follow}
							onValueChange={(v) => patch({ follow: v as BlobFollow })}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FOLLOW_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Reticle shape">
						<Select
							value={effect.shape}
							onValueChange={(v) => patch({ shape: v as BlobShape })}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SHAPE_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>

					<SectionField label="Beat-react (synced pops)">
						<Switch
							checked={effect.beatReact}
							onCheckedChange={(c) => patch({ beatReact: c })}
						/>
					</SectionField>

					<SectionField label="Single-color tint">
						<Switch
							checked={tinted}
							onCheckedChange={(c) =>
								patch({ color: c ? FADI_PALETTE[4] : null })
							}
						/>
					</SectionField>

					{tinted && (
						<SectionField label="Blob color">
							<div className="flex flex-col gap-2">
								<ColorPicker
									value={(effect.color ?? FADI_PALETTE[4])
										.replace(/^#/, "")
										.toUpperCase()}
									onChange={(c) => patch({ color: `#${c}` })}
									onChangeEnd={(c) => patch({ color: `#${c}` })}
								/>
								<div className="flex gap-1.5">
									{FADI_PALETTE.map((hex) => (
										<button
											key={hex}
											type="button"
											title={hex}
											onClick={() => patch({ color: hex })}
											className={cn(
												"size-5 rounded-full border",
												effect.color?.toUpperCase() === hex
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

					<SectionField label={`Tracked points ${maxFeatures}`}>
						<Slider
							min={20}
							max={300}
							step={10}
							value={[maxFeatures]}
							onValueChange={([v]) => patchParams({ maxFeatures: v })}
						/>
					</SectionField>

					<SectionField label={`Reticles / frame ${maxReticles}`}>
						<Slider
							min={4}
							max={60}
							step={1}
							value={[maxReticles]}
							onValueChange={([v]) => patchParams({ maxReticles: v })}
						/>
					</SectionField>
				</SectionFields>
			</Section>
		</div>
	);
}

export default BlobTrackEffectPanel;
