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
