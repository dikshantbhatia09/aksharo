/**
 * B20's consumption interface for packed zoom/reframe keyframe curves.
 *
 * B20 (proposal UI + export application) codes against this exact name and
 * shape and swaps in this implementation when B19 lands. It is a thin,
 * ergonomic wrapper: `Keyframe.zoom` names the same value `../keyframes.ts`
 * calls `scale`, and this module adds a per-row `ease` this work package's
 * pass items only carry once per item (`ZoomPayload.easing`/the render-core
 * transform command's own interpolation) — see "Byte layout" below for how
 * the two are reconciled.
 *
 * ### Byte layout (little-endian, version 1)
 *
 * ```
 * offset  size  field
 * 0       4     magic   ASCII "MKF2" (0x4D 0x4B 0x46 0x32)
 * 4       4     version uint32 LE, currently 1
 * 8       4     count   uint32 LE, number of keyframe rows
 * 12      20*n  rows    n x { tMs: f32, zoom: f32, cx: f32, cy: f32, ease: f32 }, all LE
 * ```
 *
 * `ease` is packed as a float for a fixed-width row (0.0 = `"linear"`, 1.0 =
 * `"inOut"`) rather than a separate byte, so every row stays a flat run of
 * IEEE-754 binary32 values a `Float32Array` can address directly.
 *
 * This is a distinct wire format from `../keyframes.ts`'s `MKF1`
 * (`[tMs, cx, cy, scale]`, no per-row ease) — that module is what this work
 * package's own worker→API pipeline packs and unpacks internally
 * (`apps/worker-ai/worker_ai/processors/reframe_zoom_pass.pack_keyframes`,
 * `PassCompletionHandler`), documented and round-trip-tested on its own
 * before this file existed. Reconciling the two into one on-disk format is
 * flagged as an open question in B19's final report — this module is the
 * stable name/shape B20 depends on regardless of which byte layout ends up
 * on `edg_pass_items.keyframes`/`keyframesRef` once that reconciliation
 * happens; only this file's internals would need to change, not its
 * exported name or `Keyframe` shape.
 */

export type Ease = "linear" | "inOut";

/** One decoded keyframe: a subject/crop centre and zoom factor at a time offset. */
export interface Keyframe {
  /** Milliseconds relative to the item's `startMs`. */
  readonly tMs: number;
  /** Zoom factor, >= 1 (1 meaning "no zoom"). */
  readonly zoom: number;
  /** Subject/crop centre x, normalised 0..1. */
  readonly cx: number;
  /** Subject/crop centre y, normalised 0..1. */
  readonly cy: number;
  readonly ease: Ease;
}

const MAGIC_BYTES = [0x4d, 0x4b, 0x46, 0x32] as const; // "M","K","F","2"
const CURRENT_VERSION = 1;
const HEADER_BYTES = 12;
const ROW_BYTES = 20;

const EASE_TO_FLOAT: Record<Ease, number> = { linear: 0, inOut: 1 };
const FLOAT_TO_EASE: readonly Ease[] = ["linear", "inOut"];

export class KeyframeDecodeError extends Error {
  override readonly name = "KeyframeDecodeError";
}

/** Encode keyframes as the packed little-endian buffer described above. */
export function encodeKeyframes(frames: readonly Keyframe[]): Uint8Array {
  const ordered = [...frames].sort((a, b) => a.tMs - b.tMs);
  const buffer = new ArrayBuffer(HEADER_BYTES + ordered.length * ROW_BYTES);
  const view = new DataView(buffer);

  view.setUint8(0, MAGIC_BYTES[0]);
  view.setUint8(1, MAGIC_BYTES[1]);
  view.setUint8(2, MAGIC_BYTES[2]);
  view.setUint8(3, MAGIC_BYTES[3]);
  view.setUint32(4, CURRENT_VERSION, true);
  view.setUint32(8, ordered.length, true);

  ordered.forEach((frame, index) => {
    const offset = HEADER_BYTES + index * ROW_BYTES;
    view.setFloat32(offset, frame.tMs, true);
    view.setFloat32(offset + 4, frame.zoom, true);
    view.setFloat32(offset + 8, frame.cx, true);
    view.setFloat32(offset + 12, frame.cy, true);
    view.setFloat32(offset + 16, EASE_TO_FLOAT[frame.ease], true);
  });

  return new Uint8Array(buffer);
}

/** Decode a buffer `encodeKeyframes` produced. Throws {@link KeyframeDecodeError} on anything else. */
export function decodeKeyframes(bytea: Uint8Array): Keyframe[] {
  if (bytea.length < HEADER_BYTES) {
    throw new KeyframeDecodeError(`keyframe buffer too short: ${String(bytea.length)} bytes`);
  }
  const view = new DataView(bytea.buffer, bytea.byteOffset, bytea.byteLength);
  const magic =
    view.getUint8(0) === MAGIC_BYTES[0] &&
    view.getUint8(1) === MAGIC_BYTES[1] &&
    view.getUint8(2) === MAGIC_BYTES[2] &&
    view.getUint8(3) === MAGIC_BYTES[3];
  if (!magic) {
    throw new KeyframeDecodeError("bad magic: not a packed keyframe buffer (expected MKF2)");
  }
  const version = view.getUint32(4, true);
  if (version !== CURRENT_VERSION) {
    throw new KeyframeDecodeError(`unsupported keyframe version: ${String(version)}`);
  }
  const count = view.getUint32(8, true);
  const expected = HEADER_BYTES + count * ROW_BYTES;
  if (bytea.length !== expected) {
    throw new KeyframeDecodeError(
      `keyframe buffer length ${String(bytea.length)} does not match count=${String(count)} ` +
        `(expected ${String(expected)})`,
    );
  }

  const frames: Keyframe[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * ROW_BYTES;
    const easeValue = view.getFloat32(offset + 16, true);
    const ease = FLOAT_TO_EASE[Math.round(easeValue)];
    if (ease === undefined) {
      throw new KeyframeDecodeError(
        `unrecognised ease value at row ${String(index)}: ${String(easeValue)}`,
      );
    }
    frames.push({
      tMs: view.getFloat32(offset, true),
      zoom: view.getFloat32(offset + 4, true),
      cx: view.getFloat32(offset + 8, true),
      cy: view.getFloat32(offset + 12, true),
      ease,
    });
  }
  return frames;
}
