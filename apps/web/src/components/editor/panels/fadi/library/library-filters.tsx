"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/utils/ui";
import type { AssetFilters, AssetKind, RootStatus, TagCount } from "./types";

const KINDS: { value: AssetKind | undefined; label: string }[] = [
	{ value: undefined, label: "All" },
	{ value: "video", label: "Video" },
	{ value: "image", label: "Image" },
	{ value: "audio", label: "Audio" },
];

const HINTS = ["loop", "overlay", "clip", "footage"] as const;

/**
 * Search + filter controls for the Fadi library: text query, media-kind chips,
 * root-kind hint chips (loop/overlay/clip/footage), an alpha-only toggle, and a tag
 * cloud. Pure-controlled — owns no state; emits a new filters object to the panel.
 */
export function LibraryFilters({
	filters,
	onChange,
	tags,
	roots,
}: {
	filters: AssetFilters;
	onChange: (next: AssetFilters) => void;
	tags: TagCount[];
	roots: RootStatus[];
}) {
	const patch = (p: Partial<AssetFilters>) => onChange({ ...filters, ...p });
	const toggleTag = (tag: string) => {
		const current = new Set(filters.tags ?? []);
		if (current.has(tag)) current.delete(tag);
		else current.add(tag);
		patch({ tags: [...current] });
	};

	const onlineRoots = roots.filter((r) => r.online);

	return (
		<div className="flex flex-col gap-2 border-b p-2">
			<Input
				value={filters.q ?? ""}
				onChange={(e) => patch({ q: e.target.value })}
				placeholder="Search loops, overlays, clips…"
				className="h-8"
			/>

			<div className="flex flex-wrap gap-1">
				{KINDS.map((k) => (
					<Chip
						key={k.label}
						active={filters.kind === k.value}
						onClick={() => patch({ kind: k.value })}
					>
						{k.label}
					</Chip>
				))}
				<span className="bg-border mx-1 w-px" />
				{HINTS.map((h) => (
					<Chip
						key={h}
						active={filters.kind_hint === h}
						onClick={() =>
							patch({ kind_hint: filters.kind_hint === h ? undefined : h })
						}
					>
						{h}
					</Chip>
				))}
				<Chip
					active={filters.has_alpha === true}
					onClick={() =>
						patch({ has_alpha: filters.has_alpha === true ? undefined : true })
					}
				>
					alpha
				</Chip>
			</div>

			{onlineRoots.length > 1 && (
				<select
					className="bg-background h-7 rounded border px-1 text-xs"
					value={filters.root_label ?? ""}
					onChange={(e) => patch({ root_label: e.target.value || undefined })}
				>
					<option value="">All roots ({onlineRoots.length} online)</option>
					{onlineRoots.map((r) => (
						<option key={r.label} value={r.label}>
							{r.label} ({r.indexed_count})
						</option>
					))}
				</select>
			)}

			{tags.length > 0 && (
				<div className="flex max-h-16 flex-wrap gap-1 overflow-y-auto">
					{tags.slice(0, 24).map((t) => (
						<Chip
							key={t.tag}
							active={(filters.tags ?? []).includes(t.tag)}
							onClick={() => toggleTag(t.tag)}
						>
							{t.tag}
							<span className="opacity-50"> {t.count}</span>
						</Chip>
					))}
				</div>
			)}
		</div>
	);
}

function Chip({
	active,
	onClick,
	children,
}: {
	active?: boolean;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-full border px-2 py-0.5 text-xs transition-colors",
				active
					? "bg-primary text-primary-foreground border-primary"
					: "bg-background hover:bg-accent text-muted-foreground",
			)}
		>
			{children}
		</button>
	);
}
