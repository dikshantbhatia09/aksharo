/**
 * Packed keyframe decode/encode — B19's real implementation, re-exported.
 *
 * B20 was written against a self-documented, invented interim shape here
 * (`decodeKeyframes(bytea, kind) → Keyframe[]`, `[tMs, x, y, w, h]` float32
 * rows, absolute `tMs`) before B19 landed on `main`, per the brief's "if the
 * decoder is absent when you start, write the consumer against a documented
 * interface ... and note it as the seam for B19 to satisfy". B19 landed its
 * own implementation of exactly that seam at `@montaj/edg`'s
 * `passes/keyframes.ts` — format `"MKF2"`, `Keyframe = {tMs, zoom, cx, cy,
 * ease}`, `tMs` **relative to the pass item's `startMs`** rather than
 * absolute — a materially different shape from what this file invented
 * (reported in full in the B20 final report). This module now just
 * re-exports B19's real one so nothing importing `decodeKeyframes` from
 * `apps/web/lib/passes/keyframes` had to change its import path; the actual
 * decode/encode logic, and the manifest-track → output-clock conversion, live
 * in `@montaj/render-core`'s `frame/keyframe-track.ts` (shared with the cloud
 * renderer) — see that module for the `Keyframe` → crop-rectangle reduction
 * (`cropRectFromCentre`) both render paths use.
 */
export {
  decodeKeyframes,
  encodeKeyframes,
  type Ease,
  type Keyframe,
  KeyframeDecodeError,
} from "@montaj/edg";
