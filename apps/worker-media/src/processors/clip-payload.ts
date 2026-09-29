/**
 * `media.clip`'s payload, restated for this worker and checked before any work
 * starts (2026-10-04).
 *
 * The contract is `MediaClipPayloadSchema` in `@montaj/repurpose-contracts`.
 * A worker cannot import it (`queues.ts` says why), so it restates the part it
 * needs. Until now the restatement was a TypeScript cast, and a field the
 * worker did not know was dropped without a word: a worker older than the API
 * would have cut an audio-only source without the picture the payload asked
 * for (an `audiogram`), and the clip would have come back with no video stream,
 * looking finished. So a payload naming any field this worker does not know is
 * refused, once and loudly (`worker/outdated`), and the fields it does know are
 * checked where a wrong value would reach a filtergraph or another workspace.
 *
 * `clip-payload.test.ts` reads `MEDIA_CLIP_PAYLOAD_FIELDS` out of the contract's
 * source and holds {@link CLIP_PAYLOAD_FIELDS} to it, so the two cannot drift.
 */

import {
  AUDIOGRAM_ARTWORK_FORMATS,
  isHexColour,
  type AudiogramArtworkFormat,
  type AudiogramRequest,
} from "./audiogram.js";
import { MediaJobError, unreadableMedia } from "../errors.js";

/** Every field of a `media.clip@1` payload this worker understands, in order. */
export const CLIP_PAYLOAD_FIELDS = [
  "aspect",
  "audiogram",
  "candidateId",
  "clipId",
  "destination",
  "endMs",
  "handleMs",
  "profile",
  "profileVersion",
  "reframe",
  "runId",
  "schemaVersion",
  "source",
  "sourceDurationMs",
  "startMs",
  "subtitles",
] as const;

const KNOWN: ReadonlySet<string> = new Set(CLIP_PAYLOAD_FIELDS);
const AUDIOGRAM_FIELDS: ReadonlySet<string> = new Set(["background", "accent", "artwork"]);
const ARTWORK_FIELDS: ReadonlySet<string> = new Set(["key", "format"]);

/** A storage key built from ids, never from a filename (the contract's own rule). */
const STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/** The fields of `payload` this worker does not know, sorted; empty when there are none. */
export function unknownClipFields(payload: object): string[] {
  return Object.keys(payload)
    .filter((field) => !KNOWN.has(field))
    .sort();
}

/**
 * Refuse a payload that asks for something this worker does not know how to
 * do. Not retried: every attempt on this worker would refuse it the same way,
 * and the clip is cut again - by a worker that knows the field - once it has
 * been deployed and the person (or Autopilot) asks.
 */
export function assertKnownClipFields(payload: object): void {
  const unknown = unknownClipFields(payload);
  if (unknown.length === 0) return;
  throw new MediaJobError(
    "worker/outdated",
    `This worker does not know media.clip's ${unknown.join(", ")}: it is older than the API ` +
      "that asked. Deploy worker-media, then cut the clip again.",
    { retryable: false },
  );
}

/**
 * The payload's `audiogram`, checked, or `undefined` when there is none.
 *
 * The colours reach a filtergraph, so they are `#RRGGBB` and nothing else; the
 * artwork is read from the derived store, so its key must be a plain key in
 * this job's own workspace (`ws/{workspaceId}/…`), never another's.
 *
 * @throws MediaJobError `media/unreadable` (`media/unsupported`) for anything
 *   else, not retried: the same payload is refused the same way every time.
 */
export function readAudiogram(value: unknown, workspaceId: string): AudiogramRequest | undefined {
  if (value === undefined) return undefined;
  const refuse = (why: string): MediaJobError =>
    unreadableMedia(`Invalid media.clip audiogram: ${why}.`, "media/unsupported");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refuse("not an object");
  }
  const record = value as Record<string, unknown>;
  const stray = Object.keys(record).filter((field) => !AUDIOGRAM_FIELDS.has(field));
  if (stray.length > 0) throw refuse(`unknown ${stray.sort().join(", ")}`);
  const { background, accent, artwork } = record;
  if (!isHexColour(background) || !isHexColour(accent)) throw refuse("a colour is not #RRGGBB");
  if (artwork === undefined) return { background, accent };

  if (typeof artwork !== "object" || artwork === null || Array.isArray(artwork)) {
    throw refuse("the artwork is not an object");
  }
  const art = artwork as Record<string, unknown>;
  const strayArt = Object.keys(art).filter((field) => !ARTWORK_FIELDS.has(field));
  if (strayArt.length > 0) throw refuse(`unknown artwork ${strayArt.sort().join(", ")}`);
  const { key, format } = art;
  if (
    typeof key !== "string" ||
    key.length > 512 ||
    !STORAGE_KEY.test(key) ||
    key.includes("..") ||
    !key.startsWith(`ws/${workspaceId}/`)
  ) {
    throw refuse("the artwork is not an object of this workspace");
  }
  if (!(AUDIOGRAM_ARTWORK_FORMATS as readonly unknown[]).includes(format)) {
    throw refuse("the artwork is not a PNG, JPEG or WebP");
  }
  return { background, accent, artwork: { key, format: format as AudiogramArtworkFormat } };
}
