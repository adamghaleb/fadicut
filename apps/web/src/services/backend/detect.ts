// ---------------------------------------------------------------------------
// Runtime detection & backend factory
// ---------------------------------------------------------------------------

import type { EditorBackend } from "./types";

/**
 * Returns true when running inside a Tauri webview.
 *
 * Detection relies on the `__TAURI_INTERNALS__` global that the Tauri
 * runtime injects before any user code runs. This is the officially
 * recommended detection method.
 */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Singleton — resolved once per app lifecycle.
let cachedBackend: EditorBackend | null = null;

/**
 * Lazily resolve and cache the correct backend implementation.
 *
 * - In a Tauri webview → dynamically imports `./tauri-backend`
 * - In a plain browser  → dynamically imports `./browser-backend`
 *
 * Using dynamic imports keeps the unused backend out of the bundle.
 */
export async function getBackend(): Promise<EditorBackend> {
	if (cachedBackend) return cachedBackend;

	if (isTauri()) {
		const { createTauriBackend } = await import("./tauri-backend");
		cachedBackend = createTauriBackend();
	} else {
		const { createBrowserBackend } = await import("./browser-backend");
		cachedBackend = createBrowserBackend();
	}

	return cachedBackend;
}

/**
 * Synchronous access to the backend after it has been initialized.
 * Throws if `getBackend()` has not been awaited at least once.
 */
export function getBackendSync(): EditorBackend {
	if (!cachedBackend) {
		throw new Error(
			"Backend not initialized. Call and await getBackend() during app startup.",
		);
	}
	return cachedBackend;
}
