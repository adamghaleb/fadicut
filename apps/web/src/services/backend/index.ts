// Backend abstraction — public API
//
// Usage:
//   import { getBackend } from "@/services/backend";
//   const backend = await getBackend();
//   const probe = await backend.decode.probe(file);

export { getBackend, getBackendSync, isTauri } from "./detect";

export type {
	EditorBackend,
	RenderBackend,
	EncodeBackend,
	EncodeSession,
	EncodeParams,
	DecodeBackend,
	FileIOBackend,
	FileHandle,
	AudioBackend,
	AudioMixClip,
	AudioPeaks,
	CompositeLayer,
	FrameImage,
	ProgressEvent,
	MediaProbe,
} from "./types";
