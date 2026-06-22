"use client";

import { Button } from "@/components/ui/button";

/**
 * Graceful offline state for the Fadi library. Shown when the Bridge is unreachable
 * (not running) or when every asset root is offline (Seagate drive unplugged). The
 * editor itself keeps working — this panel just explains what's missing and offers a
 * retry. Never a hard error, per the degrade-gracefully requirement.
 */
export function LibraryOffline({
	reason,
	onRetry,
	offlineRootLabels,
}: {
	reason: "bridge" | "drive";
	onRetry: () => void;
	offlineRootLabels?: string[];
}) {
	const isBridge = reason === "bridge";
	return (
		<div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<div className="text-3xl opacity-40">{isBridge ? "⚲" : "⤫"}</div>
			<p className="text-sm font-medium">
				{isBridge ? "Fadi Bridge offline" : "Asset drive offline"}
			</p>
			<p className="max-w-xs text-xs leading-relaxed">
				{isBridge ? (
					<>
						The local Fadi Bridge isn&apos;t responding. Start it (
						<code className="bg-accent rounded px-1">bridge/run.sh</code>) to
						browse your loops, overlays, and clips. The editor still works
						without it.
					</>
				) : (
					<>
						The Seagate drive (and any other removable roots) appears unplugged,
						so those packs can&apos;t be browsed right now. On-disk roots are
						still available.
					</>
				)}
			</p>
			{offlineRootLabels && offlineRootLabels.length > 0 && (
				<ul className="text-[0.7rem] opacity-70">
					{offlineRootLabels.map((l) => (
						<li key={l}>• {l}</li>
					))}
				</ul>
			)}
			<Button size="sm" variant="outline" onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}
