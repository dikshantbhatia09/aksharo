import { createHmac } from "node:crypto";

import { loadRepoEnv } from "./env";
import { API_ORIGIN } from "./fixtures";

/**
 * The worker → API completion callback (CONTRACTS §3), signed the same way a
 * real worker would — this is the "API-side test hook" the brief allows for
 * simulating a job outcome without running `apps/worker-media`: the suite
 * uploads for real (straight to MinIO, CONTRACTS §6) but a job's *processing*
 * is simulated by calling this exactly as the worker's own callback would.
 *
 * ```
 * X-Montaj-Attempt:   <attemptId>
 * X-Montaj-Timestamp: <unix seconds>
 * X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
 * ```
 *
 * `attemptId` must be the job's own — `JobsService.staleReason` answers a
 * mismatched one with `{applied: false, reason: "stale_attempt"}` (a 200, not
 * an error, since a genuine worker retry looks exactly the same on the wire),
 * so a caller here has to read the real one off `GET /jobs` first rather than
 * invent one.
 */
function sign(secret: string, timestamp: number, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${String(timestamp)}.`);
  hmac.update(body);
  return hmac.digest("hex");
}

export interface JobCallbackAck {
  readonly applied: boolean;
  readonly jobId: string;
  readonly status: string;
  readonly reason?: string;
}

export async function completeJobForTest(
  jobId: string,
  attemptId: string,
  outcome: { status: "succeeded" | "failed"; result?: unknown; error?: unknown },
): Promise<JobCallbackAck> {
  const env = loadRepoEnv();
  const secret = env["INTERNAL_CALLBACK_SECRET"];
  if (secret === undefined || secret === "") {
    throw new Error("INTERNAL_CALLBACK_SECRET is not set — copy .env.example to .env first.");
  }

  const body = JSON.stringify(outcome);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${API_ORIGIN}/internal/jobs/${jobId}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-montaj-attempt": attemptId,
      "x-montaj-timestamp": String(timestamp),
      "x-montaj-signature": sign(secret, timestamp, body),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `completeJobForTest(${jobId}) -> HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  const ack = (await response.json()) as JobCallbackAck;
  if (!ack.applied) {
    throw new Error(`completeJobForTest(${jobId}) was not applied: ${JSON.stringify(ack)}`);
  }
  return ack;
}

/**
 * `POST /internal/projects/{id}/edg/ops` (`edg-internal.controller.ts`) —
 * the only route that can submit `source: "worker"` ops, signed the same
 * way as the job-completion callback. Used by B20b's timeline drag-to-adjust
 * Playwright case to land a proposed pass item directly, the way
 * `PassCompletionHandler` would after a real `ai.pass` job, without running
 * a worker.
 */
export async function mergePassForTest(
  projectId: string,
  input: { baseRevision: number; pass: Record<string, unknown>; opId: string },
): Promise<{ revision: number }> {
  const env = loadRepoEnv();
  const secret = env["INTERNAL_CALLBACK_SECRET"];
  if (secret === undefined || secret === "") {
    throw new Error("INTERNAL_CALLBACK_SECRET is not set — copy .env.example to .env first.");
  }

  const body = JSON.stringify({
    baseRevision: input.baseRevision,
    ops: [{ opId: input.opId, type: "MergePass", pass: input.pass }],
    clientOpIds: [],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${API_ORIGIN}/internal/projects/${projectId}/edg/ops`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-montaj-attempt": "e2e-merge-pass",
      "x-montaj-timestamp": String(timestamp),
      "x-montaj-signature": sign(secret, timestamp, body),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `mergePassForTest(${projectId}) -> HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  return (await response.json()) as { revision: number };
}

export interface MediaPatchAck {
  readonly mediaId: string;
  readonly status: string;
}

/**
 * `PATCH /internal/media/{id}` (`internal-media.controller.ts`) — the real
 * `worker-media`'s write-back path for `media.probe`/`media.proxy` results
 * (technical facts, derived-object keys, and the `status` flip to `ready`).
 *
 * `completeJobForTest` alone is now enough for `status` itself: A07b's
 * `MediaProxyCompletionHandler` flips a `media.proxy` job's own completion to
 * `media_assets.status: "ready"`/`"failed"` independently of this route. Use
 * this helper only when a suite specifically needs a derived key
 * (`proxyKey`, `waveformKey`, ...) that only the worker's write-back writes.
 */
export async function patchMediaForTest(
  mediaId: string,
  patch: Record<string, unknown>,
): Promise<MediaPatchAck> {
  const env = loadRepoEnv();
  const secret = env["INTERNAL_CALLBACK_SECRET"];
  if (secret === undefined || secret === "") {
    throw new Error("INTERNAL_CALLBACK_SECRET is not set — copy .env.example to .env first.");
  }

  const body = JSON.stringify(patch);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${API_ORIGIN}/internal/media/${mediaId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-montaj-attempt": "e2e-media-patch",
      "x-montaj-timestamp": String(timestamp),
      "x-montaj-signature": sign(secret, timestamp, body),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `patchMediaForTest(${mediaId}) -> HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  return (await response.json()) as MediaPatchAck;
}
