/**
 * Queue names, the job envelope and the media payloads, frozen in
 * `docs/CONTRACTS.md` §3.
 *
 * A08 owns the canonical TypeScript copy (`apps/api/src/jobs/contracts/`), but a
 * worker cannot import across app boundaries, so the literal names live here and
 * `queues.test.ts` parses the API's file to prove the two have not drifted — the
 * same guard `apps/worker-ai/tests/test_queues.py` gives the Python side.
 *
 * `montaj` in the queue names is the engineering codename and is correct — the
 * brand rule (CONTRACTS §0) covers user-visible strings only.
 */

export const QUEUE_NAMES = [
  "media.probe",
  "media.proxy",
  "media.acquire",
  "media.clip",
  "ai.vad",
  "ai.transcribe",
  "ai.align",
  "ai.diarise",
  "ai.translate",
  "ai.transliterate",
  "ai.clean",
  "ai.pass",
  "ai.llm",
  "ai.highlights",
  "ai.faces",
  "render.video",
  "render.subtitle",
  "publish.dispatch",
  "publish.reconcile",
  "notify",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Queues this worker consumes.
 *
 * `media.clip` is in QUEUE_NAMES from REP-005 but is NOT here: registering a name
 * is a contract, consuming it is an implementation, and its processor arrives in
 * Wave 6. A job enqueued on it today would sit in Redis, which is why nothing
 * enqueues it until then.
 *
 * `media.acquire` IS consumed (REP-010), and since 2026-09-15 it is produced too:
 * creating a link-sourced run enqueues one. It stays gated on
 * `source_youtube_acquire`, which is seeded off, so a deployment that has not
 * enabled the flag still sees no acquisitions.
 */
export const MEDIA_PROBE_QUEUE = "media.probe" satisfies QueueName;
export const MEDIA_PROXY_QUEUE = "media.proxy" satisfies QueueName;
export const MEDIA_ACQUIRE_QUEUE = "media.acquire" satisfies QueueName;
export const MEDIA_CLIP_QUEUE = "media.clip" satisfies QueueName;

/** The media queues consumed by this worker. */
export const MEDIA_QUEUES = [
  MEDIA_ACQUIRE_QUEUE,
  MEDIA_PROBE_QUEUE,
  MEDIA_PROXY_QUEUE,
  MEDIA_CLIP_QUEUE,
] as const;

export type MediaQueue = (typeof MEDIA_QUEUES)[number];

/** Every job's `data`, identical across queues (CONTRACTS §3). */
export interface JobEnvelope<TPayload = unknown> {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly priority: number;
  /** Deduplication key: the same key must never run twice concurrently. */
  readonly jobKey: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly payload: TPayload;
}

/**
 * What the RUNTIME reads off a media payload, before any processor sees it.
 *
 * Deliberately weaker than {@link MediaProbePayload}: `media.acquire` has no
 * source key, so a shared narrow type cannot promise one. Each processor casts
 * to its own payload type, which is where the real shape is asserted.
 */
export interface MediaJobPayload {
  readonly mediaId?: string;
  readonly clipId?: string;
  readonly projectId?: string | null;
  /** Present on the queues that READ an object. */
  readonly key?: string;
  /** Present on the queues that WRITE one. */
  readonly destination?: { readonly key?: string };
}

/**
 * Payload of a `media.probe` job, as `MediaService.startPipeline` writes it.
 *
 * Everything except `mediaId` and `key` is a convenience: the worker rebuilds the
 * CONTRACTS §6 keys from the envelope's ids rather than trusting a path in a
 * payload, so a job replayed from the dead-letter queue a month later still
 * writes to the right place.
 */
export interface MediaProbePayload {
  readonly mediaId: string;
  readonly projectId?: string | null;
  readonly bucket?: string;
  /** Raw object key: `ws/{ws}/p/{project}/media/{media}/raw.{ext}` (CONTRACTS §6). */
  readonly key: string;
  readonly mime?: string | null;
  readonly sizeBytes?: number;
  readonly derivedBucket?: string;
  readonly derivedPrefix?: string;
}

/**
 * Payload of a `media.proxy` job, as the probe's completion handler writes it.
 *
 * The measured fields are hints that save a second probe; `processProxy` measures
 * for itself when one is missing.
 */
export interface MediaProxyPayload extends MediaProbePayload {
  readonly durationMs?: number;
  readonly hasVideo?: boolean;
  readonly hasAudio?: boolean;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly hdr?: boolean;
}

/** Narrow an unknown BullMQ `job.data` to the contract envelope. */
export function isJobEnvelope(value: unknown): value is JobEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["jobId"] === "string" &&
    typeof candidate["attemptId"] === "string" &&
    typeof candidate["workspaceId"] === "string" &&
    typeof candidate["jobKey"] === "string" &&
    typeof candidate["createdAt"] === "string" &&
    "payload" in candidate
  );
}

/**
 * Narrow a payload to the minimum every media job needs.
 *
 * Two shapes, because the queues address their object differently and both are
 * legitimate. `media.probe` and `media.proxy` are given a `key` — the object
 * they READ. `media.acquire` has nothing to read yet; it is given
 * `destination.key`, the object it will WRITE. Requiring a top-level `key`
 * rejected every acquisition at the envelope check, which is a permanent failure
 * with a message about CONTRACTS §3 and no hint that the producer and the guard
 * simply disagreed about a field name.
 *
 * What both shapes must have is `mediaId`: the runtime patches that row and
 * reports failures against it before any processor runs.
 */
export function isMediaPayload(value: unknown): value is MediaJobPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasId =
    (typeof candidate["mediaId"] === "string" && candidate["mediaId"] !== "") ||
    (typeof candidate["clipId"] === "string" && candidate["clipId"] !== "");
  if (!hasId) return false;
  if (typeof candidate["key"] === "string" && candidate["key"] !== "") return true;

  const destination = candidate["destination"];
  if (typeof destination !== "object" || destination === null) return false;
  const key = (destination as Record<string, unknown>)["key"];
  return typeof key === "string" && key !== "";
}
