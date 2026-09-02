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
  "ai.vad",
  "ai.transcribe",
  "ai.align",
  "ai.diarise",
  "ai.translate",
  "ai.transliterate",
  "ai.clean",
  "ai.pass",
  "ai.llm",
  "render.video",
  "render.subtitle",
  "notify",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Queues this worker consumes. */
export const MEDIA_PROBE_QUEUE = "media.probe" satisfies QueueName;
export const MEDIA_PROXY_QUEUE = "media.proxy" satisfies QueueName;

/** Both of them, in the order a pipeline runs them. */
export const MEDIA_QUEUES = [MEDIA_PROBE_QUEUE, MEDIA_PROXY_QUEUE] as const;

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

/** Narrow a payload to the minimum both media jobs need. */
export function isMediaPayload(value: unknown): value is MediaProbePayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["mediaId"] === "string" &&
    candidate["mediaId"] !== "" &&
    typeof candidate["key"] === "string" &&
    candidate["key"] !== ""
  );
}
