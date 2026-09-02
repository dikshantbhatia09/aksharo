/**
 * Packed keyframe curves for `zoom`/`reframe` pass items (B19).
 *
 * `PassItem.keyframesRef` (CONTRACTS §2, `packages/edg/src/schemas/pass.ts`)
 * points at a dense curve stored out of band from the EDG document. This
 * module is the one place that byte format is defined and the one place it is
 * decoded, so a worker, the API and `render-core` never disagree about it.
 *
 * ### Byte layout (little-endian, version 1)
 *
 * ```
 * offset  size  field
 * 0       4     magic   ASCII "MKF1" (0x4D 0x4B 0x46 0x31)
 * 4       4     version uint32 LE, currently 1
 * 8       4     count   uint32 LE, number of keyframe rows
 * 12      16*n  rows    n × { tMs: f32, cx: f32, cy: f32, scale: f32 }, all LE
 * ```
 *
 * Every row is 16 bytes: four IEEE-754 binary32 fields packed as a
 * `Float32Array` would lay them out (brief §5: "keyframes packed as
 * little-endian `Float32Array` rows `[tMs, cx, cy, scale]`"). `tMs` is a
 * millisecond timestamp relative to the item's `startMs`; `cx`/`cy` are the
 * subject centre normalised to the source frame (0..1); `scale` is the zoom
 * factor (>=1, 1 meaning "no zoom"). A `reframe` item's crop *window* is
 * derived from `(cx, cy, scale)` by `render-core`'s transform command
 * (A16) — this module carries the point/scale curve only, not a `Rect`, so
 * `zoom` and `reframe` items share one encoder.
 *
 * Float32 has a 24-bit mantissa, so `tMs` round-trips exactly for any integer
 * up to 2^24 (~4.66 hours) — comfortably past this pass's inputs (`docs/PLAN.md`
 * budgets a 30-minute source). Callers that need longer timelines should split
 * the curve per scene rather than widen this format.
 *
 * ### Storage
 *
 * Per the 2026-09-02 orchestrator addendum: a packed payload <= 64 KiB
 * (`INLINE_LIMIT_BYTES`) is meant to stay inline on `edg_pass_items.keyframes`
 * (bytea); a larger one is written to derived storage
 * (`.../passes/{passRunId}/{itemId}.kf`) with `keyframesRef` pointing at it.
 * `loadKeyframes` resolves either form for a render path. As of this work
 * package the inline column has no write path wired in
 * `apps/api/src/edg/edg.rows.ts` (`PassItem` — CONTRACTS §2 — carries only
 * `keyframesRef`, never inline bytes) and the `ObjectStore` port has no
 * `putObject` (uploads are client-presigned by design, "bytes never pass
 * through the API" — `apps/api/src/common/storage/object-store.ts`), so B19
 * always resolves through the `ref` branch; see the final report's open
 * questions.
 */

/** One decoded keyframe row. */
export interface KeyframeRow {
  /** Milliseconds relative to the item's `startMs`. */
  readonly tMs: number;
  /** Subject centre x, normalised 0..1. */
  readonly cx: number;
  /** Subject centre y, normalised 0..1. */
  readonly cy: number;
  /** Zoom factor, >= 1. */
  readonly scale: number;
}

const MAGIC_BYTES = [0x4d, 0x4b, 0x46, 0x31] as const; // "M","K","F","1"
const CURRENT_VERSION = 1;
const HEADER_BYTES = 12;
const ROW_BYTES = 16;

/** Inline-vs-derived-storage threshold from the 2026-09-02 orchestrator addendum. */
export const INLINE_LIMIT_BYTES = 64 * 1024;

export class KeyframeFormatError extends Error {
  override readonly name = "KeyframeFormatError";
}

/** Encode keyframe rows as the packed little-endian buffer described above. */
export function packKeyframes(rows: readonly KeyframeRow[]): Uint8Array {
  const ordered = [...rows].sort((a, b) => a.tMs - b.tMs);
  const buffer = new ArrayBuffer(HEADER_BYTES + ordered.length * ROW_BYTES);
  const view = new DataView(buffer);

  view.setUint8(0, MAGIC_BYTES[0]);
  view.setUint8(1, MAGIC_BYTES[1]);
  view.setUint8(2, MAGIC_BYTES[2]);
  view.setUint8(3, MAGIC_BYTES[3]);
  view.setUint32(4, CURRENT_VERSION, true);
  view.setUint32(8, ordered.length, true);

  ordered.forEach((row, index) => {
    const offset = HEADER_BYTES + index * ROW_BYTES;
    view.setFloat32(offset, row.tMs, true);
    view.setFloat32(offset + 4, row.cx, true);
    view.setFloat32(offset + 8, row.cy, true);
    view.setFloat32(offset + 12, row.scale, true);
  });

  return new Uint8Array(buffer);
}

/** Decode a buffer `packKeyframes` produced. Throws {@link KeyframeFormatError} on anything else. */
export function unpackKeyframes(bytes: Uint8Array): KeyframeRow[] {
  if (bytes.length < HEADER_BYTES) {
    throw new KeyframeFormatError(`keyframe buffer too short: ${String(bytes.length)} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic =
    view.getUint8(0) === MAGIC_BYTES[0] &&
    view.getUint8(1) === MAGIC_BYTES[1] &&
    view.getUint8(2) === MAGIC_BYTES[2] &&
    view.getUint8(3) === MAGIC_BYTES[3];
  if (!magic) {
    throw new KeyframeFormatError("bad magic: not a packed keyframe buffer");
  }
  const version = view.getUint32(4, true);
  if (version !== CURRENT_VERSION) {
    throw new KeyframeFormatError(`unsupported keyframe version: ${String(version)}`);
  }
  const count = view.getUint32(8, true);
  const expected = HEADER_BYTES + count * ROW_BYTES;
  if (bytes.length !== expected) {
    throw new KeyframeFormatError(
      `keyframe buffer length ${String(bytes.length)} does not match count=${String(count)} ` +
        `(expected ${String(expected)})`,
    );
  }

  const rows: KeyframeRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * ROW_BYTES;
    rows.push({
      tMs: view.getFloat32(offset, true),
      cx: view.getFloat32(offset + 4, true),
      cy: view.getFloat32(offset + 8, true),
      scale: view.getFloat32(offset + 12, true),
    });
  }
  return rows;
}

/** `void 0` is not exactly `undefined` for tooling — a codified "absent" hint. */
export type KeyframeSource =
  | { readonly kind: "inline"; readonly bytes: Uint8Array }
  | { readonly kind: "ref"; readonly ref: string };

/**
 * Resolve either storage form of a keyframe curve to rows — the "loader" the
 * 2026-09-02 addendum asks for, for B20's render paths. `readRef` fetches the
 * bytes a `ref` names (derived storage); it is injected so this module never
 * depends on an object-store client directly.
 */
export async function loadKeyframes(
  source: KeyframeSource,
  readRef: (ref: string) => Promise<Uint8Array>,
): Promise<KeyframeRow[]> {
  const bytes = source.kind === "inline" ? source.bytes : await readRef(source.ref);
  return unpackKeyframes(bytes);
}

/** Whether a packed payload should stay inline per the addendum's 64 KiB rule. */
export function fitsInline(bytes: Uint8Array): boolean {
  return bytes.byteLength <= INLINE_LIMIT_BYTES;
}
