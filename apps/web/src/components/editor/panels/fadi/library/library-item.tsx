"use client";

import { useEffect, useRef, useState } from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/utils/ui";
import { getLibraryClient } from "./library-client";
import type { CatalogAsset } from "./types";

/**
 * One catalog asset tile in the Fadi library grid.
 *
 * Preview streams from the Bridge proxy (light) over range-media; videos preview on
 * hover (muted, looped) so scrubbing the wall of loops/overlays stays cheap. The "+"
 * and double-click import the asset into the project and insert it at the playhead;
 * dragging onto the timeline imports lazily on drag-start. Alpha assets render on a
 * checkerboard so transparent ProRes 4444 loops read correctly.
 *
 * Offline assets (drive unplugged → `missing`) render dimmed and non-interactive.
 */
export function LibraryItem({
	asset,
	onAdd,
	onDragStartImport,
	onTag,
}: {
	asset: CatalogAsset;
	onAdd: (asset: CatalogAsset) => void;
	onDragStartImport: (asset: CatalogAsset) => void;
	onTag?: (asset: CatalogAsset) => void;
}) {
	const client = getLibraryClient();
	const [hovered, setHovered] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);

	const isVideo = asset.kind === "video";
	const isImage = asset.kind === "image";
	const isAudio = asset.kind === "audio";
	const proxyUrl = client.proxyUrl(asset);

	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;
		if (hovered) v.play().catch(() => {});
		else {
			v.pause();
			v.currentTime = 0;
		}
	}, [hovered]);

	const handleAdd = () => {
		if (asset.missing) return;
		onAdd(asset);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={cn(
						"group relative flex w-full flex-col gap-1",
						asset.missing && "pointer-events-none opacity-40",
					)}
				>
					<div
						className="bg-accent relative aspect-square overflow-hidden rounded-sm"
						style={asset.has_alpha ? ALPHA_CHECKER_STYLE : undefined}
						draggable={!asset.missing}
						onDragStart={() => onDragStartImport(asset)}
						onDoubleClick={handleAdd}
						onMouseEnter={() => setHovered(true)}
						onMouseLeave={() => setHovered(false)}
						title={asset.name}
					>
						{isImage && (
							// biome-ignore lint/a11y/useAltText: decorative library thumb
							<img
								src={proxyUrl}
								alt={asset.name}
								className="size-full object-cover"
								loading="lazy"
								draggable={false}
							/>
						)}
						{isVideo && (
							<video
								ref={videoRef}
								src={proxyUrl}
								className="size-full object-cover"
								muted
								loop
								playsInline
								preload="metadata"
							/>
						)}
						{isAudio && (
							<img
								src={proxyUrl}
								alt={`${asset.name} waveform`}
								className="size-full object-contain p-2"
								loading="lazy"
								draggable={false}
							/>
						)}

						{/* badges */}
						<div className="pointer-events-none absolute inset-x-1 top-1 flex flex-wrap gap-1">
							{asset.has_alpha && <Pill>alpha</Pill>}
							{asset.kind_hint && asset.kind_hint !== "mixed" && (
								<Pill>{asset.kind_hint}</Pill>
							)}
						</div>
						{asset.duration != null && (
							<span className="pointer-events-none absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[0.65rem] text-white">
								{formatDuration(asset.duration)}
							</span>
						)}

						{/* add button */}
						{!asset.missing && (
							<button
								type="button"
								className="bg-background/90 text-foreground hover:bg-background absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded opacity-0 shadow transition-opacity group-hover:opacity-100"
								onClick={(e) => {
									e.stopPropagation();
									handleAdd();
								}}
								title="Add to timeline"
								aria-label="Add to timeline"
							>
								+
							</button>
						)}
						{asset.missing && (
							<span className="absolute inset-0 flex items-center justify-center text-[0.65rem] uppercase tracking-wide">
								offline
							</span>
						)}
					</div>
					<span
						className="text-muted-foreground w-full truncate text-left text-[0.7rem]"
						title={asset.name}
					>
						{asset.name}
					</span>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem disabled={asset.missing} onClick={handleAdd}>
					Add to timeline
				</ContextMenuItem>
				{onTag && (
					<ContextMenuItem onClick={() => onTag(asset)}>
						Edit tags…
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() => navigator.clipboard?.writeText(asset.path)}
				>
					Copy path
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// Transparent-asset checkerboard (so alpha ProRes 4444 loops / PNG cutouts read).
const ALPHA_CHECKER_STYLE: React.CSSProperties = {
	backgroundImage:
		"linear-gradient(45deg, #00000018 25%, transparent 25%), linear-gradient(-45deg, #00000018 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #00000018 75%), linear-gradient(-45deg, transparent 75%, #00000018 75%)",
	backgroundSize: "16px 16px",
	backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function Pill({ children }: { children: React.ReactNode }) {
	return (
		<span className="rounded bg-black/60 px-1 text-[0.6rem] font-medium uppercase tracking-wide text-white">
			{children}
		</span>
	);
}

function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}
