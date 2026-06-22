"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { getLibraryClient } from "./library-client";
import { LibraryFilters } from "./library-filters";
import { LibraryItem } from "./library-item";
import { LibraryOffline } from "./library-offline";
import { LibraryTagEditor } from "./library-tag-editor";
import { useLibrary, useLibraryRoots } from "./use-library";
import { useLibraryImport } from "./use-library-import";
import type { AssetFilters, CatalogAsset } from "./types";

/**
 * The Fadi media-library panel (Batch E).
 *
 * Browses the Bridge asset catalog (loops, overlays, clips, footage across every Fadi
 * root incl. the Seagate drive), previews via the Bridge proxy/range-media endpoints,
 * and adds assets onto the timeline through the editor's normal import pipeline. Drag
 * or "+" both import-then-insert.
 *
 * Degrades gracefully: a missing Bridge or unplugged drive resolves to a clear offline
 * state with a retry, never a crash. On-disk roots stay browsable when removable roots
 * are offline.
 *
 * Mount point: this is a self-contained panel. The integrator adds a "Fadi" tab to the
 * assets panel (assets-panel-store + index.tsx) and renders `<LibraryPanel />` — those
 * are shared/registry files this batch deliberately does not touch.
 */
export function LibraryPanel() {
	const [filters, setFilters] = useState<AssetFilters>({
		sort: "indexed_at",
		order: "desc",
	});
	const [tagTarget, setTagTarget] = useState<CatalogAsset | null>(null);
	const [reindexing, setReindexing] = useState(false);

	const { assets, total, status, refresh } = useLibrary(filters, {
		limit: 240,
	});
	const {
		roots,
		tags,
		watcherBackend,
		totalIndexed,
		status: rootsStatus,
		refresh: refreshRoots,
	} = useLibraryRoots();
	const { addToTimeline, importAsset } = useLibraryImport();

	const offlineRootLabels = useMemo(
		() => roots.filter((r) => r.removable && !r.online).map((r) => r.label),
		[roots],
	);
	const onlineCount = roots.filter((r) => r.online).length;

	const handleReindex = useCallback(async () => {
		setReindexing(true);
		try {
			await getLibraryClient().reindex(false);
			refresh();
			refreshRoots();
			toast.success("Asset catalog reindexed");
		} catch {
			toast.error("Reindex failed — is the Bridge running?");
		} finally {
			setReindexing(false);
		}
	}, [refresh, refreshRoots]);

	const handleRetry = useCallback(() => {
		refresh();
		refreshRoots();
	}, [refresh, refreshRoots]);

	// Bridge unreachable entirely.
	if (status === "offline" && rootsStatus === "offline") {
		return (
			<div className="flex h-full flex-col">
				<Header
					total={0}
					online={0}
					backend=""
					reindexing={false}
					onReindex={handleReindex}
				/>
				<LibraryOffline reason="bridge" onRetry={handleRetry} />
			</div>
		);
	}

	// Bridge up but every root offline (e.g. only the drive is configured + unplugged).
	const allRootsOffline =
		rootsStatus === "online" && roots.length > 0 && onlineCount === 0;

	return (
		<div className="flex h-full flex-col">
			<Header
				total={totalIndexed || total}
				online={onlineCount}
				backend={watcherBackend}
				reindexing={reindexing}
				onReindex={handleReindex}
			/>

			<LibraryFilters
				filters={filters}
				onChange={setFilters}
				tags={tags}
				roots={roots}
			/>

			{offlineRootLabels.length > 0 && (
				<div className="text-muted-foreground bg-accent/40 border-b px-2 py-1 text-[0.7rem]">
					{offlineRootLabels.length} root
					{offlineRootLabels.length > 1 ? "s" : ""} offline (drive unplugged):{" "}
					{offlineRootLabels.join(", ")}
				</div>
			)}

			<div className="flex-1 overflow-y-auto p-2">
				{allRootsOffline ? (
					<LibraryOffline
						reason="drive"
						onRetry={handleRetry}
						offlineRootLabels={offlineRootLabels}
					/>
				) : status === "loading" ? (
					<div className="flex h-32 items-center justify-center">
						<Spinner />
					</div>
				) : assets.length === 0 ? (
					<EmptyState hasFilters={hasActiveFilters(filters)} />
				) : (
					<>
						<div
							className="grid gap-3"
							style={{
								gridTemplateColumns: "repeat(auto-fill, minmax(6rem, 1fr))",
							}}
						>
							{assets.map((a) => (
								<LibraryItem
									key={a.path}
									asset={a}
									onAdd={addToTimeline}
									onDragStartImport={importAsset}
									onTag={setTagTarget}
								/>
							))}
						</div>
						{total > assets.length && (
							<p className="text-muted-foreground mt-3 text-center text-xs">
								Showing {assets.length} of {total} — refine your search
							</p>
						)}
					</>
				)}
			</div>

			{tagTarget && (
				<LibraryTagEditor
					asset={tagTarget}
					onClose={() => setTagTarget(null)}
					onSaved={() => {
						refresh();
						refreshRoots();
					}}
				/>
			)}
		</div>
	);
}

function Header({
	total,
	online,
	backend,
	reindexing,
	onReindex,
}: {
	total: number;
	online: number;
	backend: string;
	reindexing: boolean;
	onReindex: () => void;
}) {
	return (
		<div className="flex items-center justify-between border-b px-2 py-1.5">
			<div className="flex flex-col">
				<span className="text-sm font-medium">Fadi Library</span>
				<span className="text-muted-foreground text-[0.65rem]">
					{total} assets · {online} root{online === 1 ? "" : "s"} online
					{backend ? ` · ${backend}` : ""}
				</span>
			</div>
			<Button
				size="sm"
				variant="ghost"
				onClick={onReindex}
				disabled={reindexing}
				className="h-7 text-xs"
			>
				{reindexing ? <Spinner className="size-3" /> : "Reindex"}
			</Button>
		</div>
	);
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
	return (
		<div className="text-muted-foreground flex h-32 flex-col items-center justify-center gap-1 text-center text-xs">
			<span className="text-2xl opacity-40">∅</span>
			<p>
				{hasFilters
					? "No assets match these filters."
					: "No assets indexed yet."}
			</p>
			{!hasFilters && <p>Run a reindex to scan your roots.</p>}
		</div>
	);
}

function hasActiveFilters(f: AssetFilters): boolean {
	return Boolean(
		f.q ||
		f.kind ||
		f.kind_hint ||
		f.has_alpha != null ||
		f.root_label ||
		(f.tags && f.tags.length > 0),
	);
}

export default LibraryPanel;
