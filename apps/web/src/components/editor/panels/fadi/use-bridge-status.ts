"use client";

/**
 * Tiny poller for the local Fadi Bridge's /health. Lets every Fadi panel show a
 * connection dot so it's obvious whether the native companion (bridge/run.sh) is up.
 * Read-only, cheap (polls every 5s, aborts in-flight on unmount), never throws.
 */

import { useEffect, useState } from "react";

export type BridgeStatus = "connecting" | "online" | "offline";

function bridgeBaseUrl(): string {
	return (
		process.env.NEXT_PUBLIC_FADI_BRIDGE_URL?.trim() || "http://127.0.0.1:8765"
	);
}

export function useBridgeStatus(pollMs = 5000): BridgeStatus {
	const [status, setStatus] = useState<BridgeStatus>("connecting");

	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const ping = async () => {
			const ctrl = new AbortController();
			const to = setTimeout(() => ctrl.abort(), 2500);
			try {
				const res = await fetch(`${bridgeBaseUrl()}/health`, {
					signal: ctrl.signal,
				});
				if (active) setStatus(res.ok ? "online" : "offline");
			} catch {
				if (active) setStatus("offline");
			} finally {
				clearTimeout(to);
				if (active) timer = setTimeout(ping, pollMs);
			}
		};

		ping();
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
		};
	}, [pollMs]);

	return status;
}
