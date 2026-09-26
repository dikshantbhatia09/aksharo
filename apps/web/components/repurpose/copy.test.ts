import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BACKGROUND_NOTE,
  CLIP_FAILURE_COPY,
  CLIP_STATE_COPY,
  REFUSAL_COPY,
  SAFE_ERROR_COPY,
  STAGE_COPY,
  beginnerSafetyViolations,
  clipFailureCopy,
  safeErrorCopy,
} from "./copy";

/**
 * The failure vocabulary is shared end to end (clips hardening, 2026-09-26):
 * the worker's reason → the run's `failure_code` (`SAFE_ERROR_CODES` in
 * `@montaj/repurpose-contracts`) → one sentence and one action here. The web
 * app does not depend on the contracts package, so the list is read from its
 * source rather than imported — the point is that adding a code there without
 * copy here fails a test instead of rendering "Something went wrong".
 */
function contractSafeErrorCodes(): string[] {
  // `__dirname`, not `import.meta.url`: under jsdom the latter is not a file URL.
  const source = readFileSync(
    join(__dirname, "../../../../packages/repurpose-contracts/src/schema.ts"),
    "utf8",
  );
  const block = /export const SAFE_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
  if (block === undefined) throw new Error("SAFE_ERROR_CODES not found in the contract");
  return [...block.matchAll(/"(repurpose\/[a-z_]+)"/g)].map((match) => match[1] ?? "");
}

describe("SAFE_ERROR_COPY against the contract", () => {
  const codes = contractSafeErrorCodes();

  it("reads a non-trivial list from the contract", () => {
    expect(codes).toContain("repurpose/source_too_large");
    expect(codes.length).toBeGreaterThanOrEqual(19);
  });

  it("has its own sentence for every code the API can write", () => {
    for (const code of codes) {
      expect(Object.hasOwn(SAFE_ERROR_COPY, code), code).toBe(true);
      expect(safeErrorCopy(code).title, code).not.toBe("Something went wrong");
    }
  });

  it("still names the two codes older runs carry", () => {
    // `analysis_failed` is what the API wrote before `highlights_failed`.
    expect(safeErrorCopy("repurpose/analysis_failed")).toEqual(
      safeErrorCopy("repurpose/highlights_failed"),
    );
    expect(safeErrorCopy("repurpose/clip_failed").action).toBe("retry");
  });
});

describe("each failure's recommended action", () => {
  const actionOf = (code: string): string => safeErrorCopy(`repurpose/${code}`).action;

  it("offers another video when this one can never work", () => {
    for (const code of [
      "source_too_large",
      "source_too_long",
      "source_private",
      "source_age_restricted",
      "source_live",
      "source_removed",
    ]) {
      expect(actionOf(code), code).toBe("choose_another");
    }
  });

  it("offers the same video again when trying again can work", () => {
    for (const code of [
      "source_unavailable",
      "source_blocked",
      "processing_failed",
      "transcription_failed",
      "highlights_failed",
      "stage_timeout",
    ]) {
      expect(actionOf(code), code).toBe("retry");
    }
  });

  it("keeps the link to fix when the link itself is the problem", () => {
    expect(actionOf("source_playlist")).toBe("edit_settings");
    expect(actionOf("source_invalid_url")).toBe("edit_settings");
  });

  it("offers picking the times when nothing was found", () => {
    expect(actionOf("highlights_no_candidates")).toBe("add_moment");
  });

  it("sends an out-of-credits run to its balance, never to buy credits that cannot be bought", () => {
    const copy = safeErrorCopy("repurpose/no_credits");
    expect(copy.action).toBe("check_credits");
    expect(`${copy.title} ${copy.reassurance}`).not.toMatch(/add credits|buy|billing/i);
  });

  it("says the bot check is temporary and about the same link", () => {
    const copy = safeErrorCopy("repurpose/source_blocked");
    expect(copy.title).toMatch(/refusing our server for a few minutes/);
    expect(copy.reassurance).toMatch(/link is fine/);
  });

  it("names the plan limit without inventing a number the page cannot know", () => {
    const copy = safeErrorCopy("repurpose/source_too_long");
    expect(copy.title).toMatch(/longer than your plan allows/);
    expect(`${copy.title} ${copy.reassurance}`).not.toMatch(/\d+ ?(minutes|min|MB)/);
  });
});

describe("clip failure copy", () => {
  it("always says the video and the other clips are safe", () => {
    for (const copy of Object.values(CLIP_FAILURE_COPY)) {
      expect(copy.reassurance).toMatch(/other clips are safe/);
    }
    expect(clipFailureCopy("media/never_heard_of_it").title).toBe("This clip could not be made");
    expect(clipFailureCopy(null).title).toBe("This clip could not be made");
  });

  it("names every code a failed cut can carry", () => {
    // The `media.clip` worker's own codes, the job ledger's, and the API's
    // "the original is gone" — none of them may fall through to the catch-all.
    for (const code of [
      "media/unreadable",
      "media/source_unavailable",
      "media/encode_failed",
      "media/encode_incomplete",
      "media/source_missing",
      "jobs/queue_timeout",
      "jobs/cancelled",
      "repurpose/source_expired",
    ]) {
      expect(Object.hasOwn(CLIP_FAILURE_COPY, code), code).toBe(true);
    }
  });

  it("gives a refused create on a moment's own card the reason it really has: a stopped run", () => {
    expect(REFUSAL_COPY.clip["repurpose/run_not_ready"]).toMatch(/stopped/);
  });

  it("offers no retry when the original video is gone, since it would only be refused", () => {
    expect(clipFailureCopy("repurpose/source_expired").retryable).toBe(false);
    expect(clipFailureCopy("media/source_missing").retryable).toBe(false);
    expect(clipFailureCopy("media/encode_failed").retryable).toBe(true);
    expect(clipFailureCopy(null).retryable).toBe(true);
  });
});

describe("every sentence on the clips pipeline", () => {
  it("contains no technical word", () => {
    const everything = [
      ...Object.values(SAFE_ERROR_COPY).flatMap((copy) => [
        copy.title,
        copy.reassurance,
        copy.actionLabel,
      ]),
      ...Object.values(STAGE_COPY).flatMap((copy) => [copy.title, copy.helper]),
      ...Object.values(CLIP_STATE_COPY),
      ...Object.values(CLIP_FAILURE_COPY).flatMap((copy) => [copy.title, copy.reassurance]),
      ...Object.values(REFUSAL_COPY).flatMap((context) => Object.values(context)),
      BACKGROUND_NOTE,
    ];
    for (const text of everything) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
    }
  });
});
