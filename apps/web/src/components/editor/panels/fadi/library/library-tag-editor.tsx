"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/utils/ui";
import { getLibraryClient } from "./library-client";
import type { CatalogAsset } from "./types";

/**
 * Lightweight tag editor for one catalog asset. Persists to the Bridge catalog
 * (POST /assets/set/tags). Used from the library item context menu. Comma/Enter add a
 * tag; click a chip to remove it.
 */
export function LibraryTagEditor({
	asset,
	onClose,
	onSaved,
}: {
	asset: CatalogAsset;
	onClose: () => void;
	onSaved: (next: CatalogAsset) => void;
}) {
	const [tags, setTags] = useState<string[]>(asset.tags ?? []);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setTags(asset.tags ?? []);
	}, [asset]);

	const addDraft = () => {
		const t = draft.trim().replace(/,$/, "");
		if (t && !tags.includes(t)) setTags([...tags, t]);
		setDraft("");
	};

	const save = async () => {
		setSaving(true);
		try {
			const updated = await getLibraryClient().mutateTags(
				"set",
				asset.path,
				tags,
			);
			onSaved(updated);
			onClose();
		} catch (err) {
			toast.error(
				`Could not save tags: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle className="truncate text-sm">
						Tags · {asset.name}
					</DialogTitle>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-3">
					<div className="flex min-h-8 flex-wrap gap-1">
						{tags.length === 0 && (
							<span className="text-muted-foreground text-xs">No tags yet</span>
						)}
						{tags.map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => setTags(tags.filter((x) => x !== t))}
								className={cn(
									"bg-accent hover:bg-destructive hover:text-destructive-foreground rounded-full px-2 py-0.5 text-xs",
								)}
								title="Remove"
							>
								{t} ✕
							</button>
						))}
					</div>
					<Input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === ",") {
								e.preventDefault();
								addDraft();
							}
						}}
						placeholder="Add a tag, press Enter"
						className="h-8"
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button size="sm" onClick={save} disabled={saving}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
