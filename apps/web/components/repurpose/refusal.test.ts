import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import { REFUSAL_COPY } from "./copy";
import { describeRefusal } from "./refusal";

function apiError(status: number, code: string, message: string, details?: unknown): ApiError {
  return new ApiError({ status, code, message, ...(details === undefined ? {} : { details }) });
}

/**
 * The start form used to render `error.message` for any API error, so admission
 * and the job ledger spoke to people directly (clips hardening, 2026-09-26).
 */
describe("describeRefusal", () => {
  it("never passes an admission refusal's own words through", () => {
    const refusal = describeRefusal(
      apiError(429, "jobs/concurrency_cap", "This workspace already has 2 jobs in flight; the free plan allows 2."),
      "start",
    );
    expect(refusal.text).toBe(REFUSAL_COPY.start.busy);
    expect(refusal.text).not.toMatch(/jobs in flight/);
  });

  it("turns an internal outage into a plain retry sentence", () => {
    const refusal = describeRefusal(
      apiError(503, "common/unavailable", "The job queue is unavailable; please retry."),
      "start",
    );
    expect(refusal.text).toBe(REFUSAL_COPY.start.fallback);
    expect(refusal.text.toLowerCase()).not.toContain("queue");
  });

  it("carries the live run's id for a link that is already being worked on", () => {
    const refusal = describeRefusal(
      apiError(409, "repurpose/source_already_running", "You are already working on this video.", {
        existingRunId: "01JS0000000000000000000OLD",
      }),
      "start",
    );
    expect(refusal.existingRunId).toBe("01JS0000000000000000000OLD");
    expect(refusal.text).toBe(REFUSAL_COPY.start["repurpose/source_already_running"]);
  });

  it("does without the id when the API does not send one", () => {
    const refusal = describeRefusal(
      apiError(409, "repurpose/source_already_running", "You are already working on this video."),
      "start",
    );
    expect(refusal.existingRunId).toBeUndefined();
  });

  it("says a connection failure is a connection failure", () => {
    expect(describeRefusal(new TypeError("Failed to fetch"), "clip").text).toBe(
      REFUSAL_COPY.clip.network,
    );
    expect(
      describeRefusal(apiError(0, "network/unreachable", "offline"), "moment").text,
    ).toBe(REFUSAL_COPY.moment.network);
  });

  it("maps each context's own codes", () => {
    expect(describeRefusal(apiError(409, "repurpose/run_not_ready", "x"), "clip").text).toBe(
      REFUSAL_COPY.clip["repurpose/run_not_ready"],
    );
    expect(
      describeRefusal(apiError(400, "repurpose/clip_bounds_invalid", "x"), "moment").text,
    ).toBe(REFUSAL_COPY.moment["repurpose/clip_bounds_invalid"]);
    expect(describeRefusal(apiError(409, "repurpose/not_retryable", "x"), "retry").text).toBe(
      REFUSAL_COPY.retry["repurpose/not_retryable"],
    );
  });
});
