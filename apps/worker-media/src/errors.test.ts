import { describe, expect, it } from "vitest";

import {
  MEDIA_FAILURE_REASONS,
  MediaJobError,
  describeError,
  redact,
  stderrTail,
  transientFailure,
  unreadableMedia,
} from "./errors.js";

/** A real presigned URL's shape, with the parts that are a credential. */
const SIGNED =
  "https://minio.local:9000/montaj-raw/ws/A/p/B/media/C/raw.mp4" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=montaj-local%2F20260902%2Fap-south-1" +
  "%2Fs3%2Faws4_request&X-Amz-Date=20260902T000000Z&X-Amz-Expires=21600" +
  "&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("redact", () => {
  it("strips a presigned URL's query string, keeping the path", () => {
    // Without this, a job's `error` column holds a working read capability for a
    // customer's raw footage (THREAT-MODEL T21).
    const redacted = redact(`[in#0] Error opening input: ${SIGNED}`);
    expect(redacted).not.toContain("X-Amz-Signature=deadbeef");
    expect(redacted).not.toContain("aws4_request");
    expect(redacted).toContain("<redacted>");
    // The path survives, because an operator needs to know WHICH object failed.
    expect(redacted).toContain("/montaj-raw/ws/A/p/B/media/C/raw.mp4");
  });

  it("strips a bare signature parameter that is not part of a URL", () => {
    expect(redact("header X-Amz-Signature=abc123 sent")).toContain("X-Amz-Signature=<redacted>");
  });

  it("leaves an ordinary diagnostic alone", () => {
    const line = "moov atom not found";
    expect(redact(line)).toBe(line);
  });
});

describe("stderrTail", () => {
  it("keeps the last lines, which is where ffmpeg says why", () => {
    const stderr = Array.from({ length: 100 }, (_unused, index) => `line ${String(index)}`).join(
      "\n",
    );
    const tail = stderrTail(stderr, 5);
    expect(tail.split("\n")).toHaveLength(5);
    expect(tail).toContain("line 99");
    expect(tail).not.toContain("line 50");
  });

  it("drops blank lines, which ffmpeg emits by the dozen", () => {
    expect(stderrTail("a\n\n\n\nb\n", 4)).toBe("a\nb");
  });

  it("redacts on the way out", () => {
    expect(stderrTail(`failed: ${SIGNED}`)).not.toContain("X-Amz-Signature=deadbeef");
  });

  it("caps the length, so one damaged file cannot fill a database column", () => {
    const huge = Array.from({ length: 50 }, () => "x".repeat(200)).join("\n");
    expect(stderrTail(huge, 40, 1_600).length).toBeLessThanOrEqual(1_601);
  });
});

describe("MediaJobError", () => {
  it("defaults to retryable, because most failures are the host's not the file's", () => {
    expect(new MediaJobError("media/x", "boom").retryable).toBe(true);
  });

  it("marks an unreadable file terminal, with a user-facing reason", () => {
    const error = unreadableMedia("no good", "media/corrupt", "moov atom not found");
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/corrupt");
    expect(error.detail).toBe("moov atom not found");
  });

  it("marks a transient failure retryable and carries no user-facing reason", () => {
    const error = transientFailure("media/store_unavailable", "the store said no");
    expect(error.retryable).toBe(true);
    expect(error.reason).toBeUndefined();
  });
});

describe("MEDIA_FAILURE_REASONS", () => {
  it("is the closed set the API's allow-list accepts", () => {
    // A worker-supplied sentence would be a worker-controlled string on a user's
    // screen; `internal-media.controller.ts` refuses anything not on this list.
    expect([...MEDIA_FAILURE_REASONS].slice(0, 5)).toEqual([
      "media/unsupported",
      "media/corrupt",
      "media/no_streams",
      "media/too_long",
      "media/probe_failed",
    ]);
    for (const reason of MEDIA_FAILURE_REASONS) expect(reason.startsWith("media/")).toBe(true);
  });
});

describe("describeError", () => {
  it("redacts, caps and never answers an empty string", () => {
    expect(describeError(new Error(`open ${SIGNED}`))).not.toContain("X-Amz-Signature=deadbeef");
    expect(describeError(new Error("x".repeat(5_000))).length).toBe(2_000);
    expect(describeError(new Error(""))).toBe("failed");
    expect(describeError("plain string")).toBe("plain string");
  });
});
