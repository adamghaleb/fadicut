"use client";

/**
 * Shared header for the Fadi editor panels (Lyrics / Library / FX).
 *
 * Gives every Fadi surface the same title + one-line muted subtitle and a single
 * restrained brand cue: a thin Fadi-spectrum accent rule under the title. Reuses the
 * editor's neutral chrome tokens (text-foreground / text-muted-foreground / border) so
 * it never clashes — the only color it introduces is the hairline gradient.
 */

import type { ReactNode } from "react";
import { cn } from "@/utils/ui";

/** The Fadi brand spectrum, used only as a restrained hairline accent. */
export const FADI_SPECTRUM = [
	"#ff2d2d",
	"#ff8a00",
	"#ffe600",
	"#3cff3c",
	"#00cfff",
	"#7a5cff",
	"#ff4fd8",
] as const;

const FADI_GRADIENT = `linear-gradient(90deg, ${FADI_SPECTRUM.join(", ")})`;

/** A 2px Fadi-spectrum hairline. Use to mark a primary Fadi action or section. */
export function FadiAccentRule({ className }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={cn("block h-0.5 w-full rounded-full", className)}
			style={{ background: FADI_GRADIENT }}
		/>
	);
}

export interface FadiPanelHeaderProps {
	title: string;
	subtitle?: ReactNode;
	/** Optional trailing control (e.g. a Reindex button), right-aligned. */
	actions?: ReactNode;
	/** Render a bottom border to separate the header from scrolling content. */
	bordered?: boolean;
	className?: string;
}

export function FadiPanelHeader({
	title,
	subtitle,
	actions,
	bordered = false,
	className,
}: FadiPanelHeaderProps) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-start justify-between gap-2 px-3 py-2.5",
				bordered && "border-b",
				className,
			)}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-col gap-1.5">
					<h2 className="text-sm font-semibold leading-none">{title}</h2>
					<FadiAccentRule className="max-w-[1.75rem] opacity-80" />
				</div>
				{subtitle ? (
					<p className="text-muted-foreground truncate text-[0.7rem] leading-tight">
						{subtitle}
					</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 items-center">{actions}</div>
			) : null}
		</div>
	);
}

export default FadiPanelHeader;
