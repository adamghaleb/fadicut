/**
 * Drive-backed project persistence (batch G, issue #7).
 *
 * Public surface the editor wires in (alongside, NOT replacing, IndexedDB):
 *
 *   import {
 *     createBridgeClientFromEnv,
 *     ProjectPersistence,
 *     newProjectMeta,
 *   } from "@/fadi/persistence";
 *
 * See README.md in this folder for the integration recipe.
 */

export * from "./types";
export { withRetry } from "./retry";
export { FadiBridgeClient, createBridgeClientFromEnv } from "./bridge-client";
export {
	ProjectPersistence,
	newProjectMeta,
	type PersistenceStatus,
	type LocalMirror,
	type ProjectPersistenceOptions,
} from "./project-persistence";
