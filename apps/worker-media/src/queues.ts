/**
 * Queue names and the job envelope, frozen in docs/CONTRACTS.md section 3.
 *
 * A08 lifts these into the shared jobs contract once the API owns producers; a
 * worker written before then must still agree with the contract exactly, so the
 * literal names live here and nowhere else in this app.
 *
 * `montaj` in the queue names is the engineering codename and is correct — the
 * brand rule (CONTRACTS section 0) covers user-visible strings only.
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

/** Queues this worker consumes. A07 adds `media.proxy` and the rest. */
export const MEDIA_PROBE_QUEUE = "media.probe" satisfies QueueName;

/** Every job's `data`, identical across queues (CONTRACTS section 3). */
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

/** Payload of a `media.probe` job. A07 fills in the real fields. */
export interface MediaProbePayload {
  readonly mediaId: string;
  /** Storage key under `ws/{workspaceId}/p/{projectId}/media/{mediaId}/` (CONTRACTS section 6). */
  readonly rawKey: string;
}

/** Result A07 will return; A01 returns the stub shape only. */
export interface MediaProbeResult {
  readonly mediaId: string;
  readonly durationMs: number | null;
  readonly probedAt: string;
  readonly stub: boolean;
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
