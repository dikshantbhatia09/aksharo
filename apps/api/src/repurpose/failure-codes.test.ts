import { describe, expect, it } from "vitest";

import { SAFE_ERROR_CODES } from "@montaj/repurpose-contracts";

import {
  LEGACY_RUN_FAILURE_CODES,
  STAGE_OF_FAILURE,
  jobErrorCodeOf,
  runFailureCode,
} from "./failure-codes.js";
import { MEDIA_FAILURE_REASONS } from "../media/media.constants.js";

import type { FailedAt } from "./failure-codes.js";

/**
 * The table in `docs/repurpose/CLIPS-HARDENING-2026-09-26.md` §2, row by row.
 * Each row is what a person reads when their video stops, so each is pinned.
 */
const SOURCE_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["media/too_large", "repurpose/source_too_large"],
  ["media/too_long", "repurpose/source_too_long"],
  ["media/source_private", "repurpose/source_private"],
  ["media/source_age_restricted", "repurpose/source_age_restricted"],
  ["media/source_live", "repurpose/source_live"],
  ["media/source_removed", "repurpose/source_removed"],
  ["media/source_blocked", "repurpose/source_blocked"],
  ["media/source_playlist", "repurpose/source_playlist"],
];

describe("runFailureCode — a download that failed", () => {
  it.each(SOURCE_TABLE)("names %s as %s", (reason, code) => {
    expect(runFailureCode({ failedAt: "acquire", mediaReason: reason })).toBe(code);
  });

  it("says 'could not get it' for a download that failed for no named reason", () => {
    expect(runFailureCode({ failedAt: "acquire", mediaReason: "media/source_failed" })).toBe(
      "repurpose/source_unavailable",
    );
  });

  it.each(["media/unsupported", "media/probe_failed", "media/corrupt", null, undefined])(
    "treats %s from the downloader as 'could not get it'",
    (reason) => {
      // Older workers borrowed these for a size refusal and a bot check; from the
      // downloader they never mean "the file could not be read".
      expect(runFailureCode({ failedAt: "acquire", mediaReason: reason })).toBe(
        "repurpose/source_unavailable",
      );
    },
  );

  it("falls back to the job's code when the worker's own reason never landed", () => {
    expect(
      runFailureCode({ failedAt: "acquire", mediaReason: null, jobErrorCode: "media/too_large" }),
    ).toBe("repurpose/source_too_large");
  });

  it("prefers the media reason when both name the source", () => {
    expect(
      runFailureCode({
        failedAt: "acquire",
        mediaReason: "media/source_blocked",
        jobErrorCode: "media/source_private",
      }),
    ).toBe("repurpose/source_blocked");
  });

  it.each(["jobs/queue_timeout", "jobs/cancelled", "media/unreadable", "common/internal"])(
    "treats a job code %s that names nothing about the source as 'could not get it'",
    (jobErrorCode) => {
      expect(runFailureCode({ failedAt: "acquire", jobErrorCode })).toBe(
        "repurpose/source_unavailable",
      );
    },
  );
});

describe("runFailureCode — a file that could not be prepared", () => {
  it.each(["media/unsupported", "media/corrupt", "media/no_streams", "media/probe_failed", null])(
    "says %s is a processing failure",
    (reason) => {
      expect(runFailureCode({ failedAt: "processing", mediaReason: reason })).toBe(
        "repurpose/processing_failed",
      );
    },
  );

  it("says a video over the plan's duration cap is too long, not unreadable", () => {
    // A link with no duration in its metadata is only measured by the probe.
    expect(runFailureCode({ failedAt: "processing", mediaReason: "media/too_long" })).toBe(
      "repurpose/source_too_long",
    );
  });

  it("ignores the job code: the media reason is the answer the probe wrote", () => {
    expect(
      runFailureCode({
        failedAt: "processing",
        mediaReason: "media/corrupt",
        jobErrorCode: "media/too_long",
      }),
    ).toBe("repurpose/processing_failed");
  });
});

describe("runFailureCode — transcription and discovery", () => {
  it.each(["credits/insufficient", "credits/needs_credits"])(
    "says %s is a lack of credits, which waiting will not fix",
    (jobErrorCode) => {
      expect(runFailureCode({ failedAt: "transcription", jobErrorCode })).toBe(
        "repurpose/no_credits",
      );
    },
  );

  it.each(["asr/provider_failed", "jobs/queue_timeout", "jobs/cancelled", null])(
    "says a transcription that ended with %s failed",
    (jobErrorCode) => {
      expect(runFailureCode({ failedAt: "transcription", jobErrorCode })).toBe(
        "repurpose/transcription_failed",
      );
    },
  );

  it("always writes highlights_failed for discovery, never the legacy analysis_failed", () => {
    for (const jobErrorCode of [null, "jobs/queue_timeout", "highlights/words_unavailable"]) {
      expect(runFailureCode({ failedAt: "highlights", jobErrorCode })).toBe(
        "repurpose/highlights_failed",
      );
    }
  });
});

describe("the vocabulary is closed", () => {
  const stages: readonly FailedAt[] = ["acquire", "processing", "transcription", "highlights"];

  it("only ever produces a code the web has a sentence for", () => {
    const inputs = [...MEDIA_FAILURE_REASONS, "anything/else", null];
    for (const failedAt of stages) {
      for (const reason of inputs) {
        for (const jobErrorCode of [...inputs, "credits/insufficient"]) {
          const code = runFailureCode({ failedAt, mediaReason: reason, jobErrorCode });
          expect(
            SAFE_ERROR_CODES,
            `${failedAt} ${String(reason)} ${String(jobErrorCode)}`,
          ).toContain(code);
        }
      }
    }
  });

  it("never produces a legacy code", () => {
    const legacy: readonly string[] = Object.values(LEGACY_RUN_FAILURE_CODES);
    for (const failedAt of stages) {
      expect(legacy).not.toContain(runFailureCode({ failedAt }));
    }
  });

  it("shows each failure on the stage the person was waiting on", () => {
    expect(STAGE_OF_FAILURE).toEqual({
      acquire: "getting_video",
      processing: "getting_video",
      transcription: "finding_clips",
      highlights: "finding_clips",
    });
  });
});

describe("jobErrorCodeOf", () => {
  it("reads the code out of a job's error JSON", () => {
    expect(jobErrorCodeOf({ code: "media/too_large", message: "x", retryable: false })).toBe(
      "media/too_large",
    );
  });

  it.each([null, undefined, "media/too_large", ["media/too_large"], { code: 7 }, {}])(
    "answers null for %j",
    (error) => {
      expect(jobErrorCodeOf(error)).toBeNull();
    },
  );
});
