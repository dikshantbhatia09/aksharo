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

/**
 * Plan limits (2026-09-27): `create` refuses before anything exists only when
 * not even a minute is affordable (402 `repurpose/no_credits` with
 * `details.creditsLeft`), and "Process the next 20 minutes" can be refused
 * because the video has nothing after this part.
 */
describe("describeRefusal for credits and the next part", () => {
  it("says the balance, and points at it, when a run cannot start for credits", () => {
    const refusal = describeRefusal(
      apiError(402, "repurpose/no_credits", "Insufficient credits: 4 tenths.", { creditsLeft: 0.4 }),
      "start",
    );
    expect(refusal.text).toBe(
      "You have 0.4 credits left, which is not enough to process a minute of video.",
    );
    expect(refusal.seeCredits).toBe(true);
    expect(refusal.text).not.toMatch(/tenths/);
  });

  it("still says it plainly, and still points at the balance, without a number", () => {
    const refusal = describeRefusal(apiError(402, "repurpose/no_credits", "x"), "start");
    expect(refusal.text).toBe(REFUSAL_COPY.start["repurpose/no_credits"]);
    expect(refusal.seeCredits).toBe(true);
    // Only a credits refusal links to the balance.
    expect(describeRefusal(apiError(429, "jobs/concurrency_cap", "x"), "start").seeCredits).toBe(
      undefined,
    );
  });

  // A link's retry fetches the video again, and is refused for credits like
  // a new run: it used to fall back to "That did not work. Try again in a
  // moment.", with no way to the balance.
  it("says a retry was refused for credits, and points at the balance", () => {
    const withBalance = describeRefusal(
      apiError(402, "repurpose/no_credits", "x", { creditsLeft: 0.4 }),
      "retry",
    );
    expect(withBalance.text).toBe(
      "You have 0.4 credits left, which is not enough to process a minute of video.",
    );
    expect(withBalance.seeCredits).toBe(true);
    const without = describeRefusal(apiError(402, "repurpose/no_credits", "x"), "retry");
    expect(without.text).toBe(REFUSAL_COPY.retry["repurpose/no_credits"]);
    expect(without.text).not.toBe(REFUSAL_COPY.retry.fallback);
    expect(without.seeCredits).toBe(true);
  });

  it("says there is nothing after this part, in plain words", () => {
    const refusal = describeRefusal(
      apiError(409, "repurpose/no_next_window", "Window end >= source duration."),
      "nextWindow",
    );
    expect(refusal.text).toBe("There is nothing after this part of the video.");
    expect(describeRefusal(new TypeError("Failed to fetch"), "nextWindow").text).toBe(
      REFUSAL_COPY.nextWindow.network,
    );
    expect(describeRefusal(apiError(500, "common/internal", "boom"), "nextWindow").text).toBe(
      REFUSAL_COPY.nextWindow.fallback,
    );
  });
});
