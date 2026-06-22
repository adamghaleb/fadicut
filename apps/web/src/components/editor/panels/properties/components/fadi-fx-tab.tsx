"use client";

/**
 * Fadi FX tab — mounts the Fadi grade + speed-ramp effect panels (issue #4) into the
 * OpenCut properties panel for video and image elements.
 *
 * The panels (GradeEffectPanel / RampEffectPanel) are store-agnostic: they take a value
 * + onChange. This tab owns persistence — it reads any stored effect off the element's
 * params (under the fadi-namespaced keys "fadi:grade" / "fadi:ramp", stored as JSON
 * strings since ParamValue is number|string|boolean) and writes changes back through the
 * timeline's undoable updateElements command.
 */

import { useCallback, useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { FadiPanelHeader } from "@/components/editor/panels/fadi/fadi-panel-header";
import type { ImageElement, VideoElement } from "@/timeline";
import {
	GradeEffectPanel,
	RampEffectPanel,
	defaultGradeEffect,
	defaultRampEffect,
	type GradeEffectParams,
	type RampEffectParams,
} from "@/components/editor/panels/fadi/effects";

/** Namespaced param keys the Fadi effects persist under on element.params. */
const GRADE_KEY = "fadi:grade";
const RAMP_KEY = "fadi:ramp";

function parseStored<T>(raw: unknown): T | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

export function FadiFxTab({
	element,
	trackId,
}: {
	element: VideoElement | ImageElement;
	trackId: string;
}) {
	const editor = useEditor();

	const grade = useMemo(
		() => parseStored<GradeEffectParams>(element.params[GRADE_KEY]),
		[element.params],
	);
	const ramp = useMemo(
		() => parseStored<RampEffectParams>(element.params[RAMP_KEY]),
		[element.params],
	);

	const persist = useCallback(
		(key: string, value: object) => {
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						patch: {
							params: {
								...element.params,
								[key]: JSON.stringify(value),
							},
						},
					},
				],
			});
		},
		[editor, trackId, element.id, element.params],
	);

	const onGradeChange = useCallback(
		(next: GradeEffectParams) => persist(GRADE_KEY, next),
		[persist],
	);
	const onRampChange = useCallback(
		(next: RampEffectParams) => persist(RAMP_KEY, next),
		[persist],
	);

	return (
		<div className="flex flex-col">
			<FadiPanelHeader
				title="Fadi FX"
				subtitle="Native-baked grade + speed ramp."
				bordered
			/>
			<div className="flex flex-col gap-2 p-2">
				<GradeEffectPanel
					value={grade ?? defaultGradeEffect()}
					onChange={onGradeChange}
				/>
				<RampEffectPanel
					value={ramp ?? defaultRampEffect()}
					onChange={onRampChange}
				/>
			</div>
		</div>
	);
}

export default FadiFxTab;
