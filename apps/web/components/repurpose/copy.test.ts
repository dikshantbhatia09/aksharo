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

  // An upload run whose file never arrived used to wait at "Add a video"
  // forever; the API now fails it. The way on is a file — but not "Upload it
  // again": the likeliest cause is a file already in another project, which the
  // workspace-wide de-duplication matches and stops, so the same file into a
  // new run would only wait a day and end here again.
  it("offers another file when an upload never arrived, and says why the same one may not work", () => {
    const copy = safeErrorCopy("repurpose/upload_missing");
    expect(copy.action).toBe("choose_another");
    expect(copy.actionLabel).toBe("Choose another video");
    expect(copy.reassurance).toMatch(/No credits were used/);
    expect(copy.reassurance).toMatch(/already in one of your projects cannot be sent here again/);
    expect(`${copy.title} ${copy.reassurance} ${copy.actionLabel}`).not.toMatch(
      /upload (it|the file) again/i,
    );
  });

  // It used to end as "we did not find a moment worth suggesting", which blamed
  // the video for a transcript that had no timings to place a moment in.
  it("names a transcript with no timings, and offers the same video started afresh", () => {
    const copy = safeErrorCopy("repurpose/transcript_untimed");
    expect(copy.action).toBe("start_again");
    expect(copy.title).toMatch(/no timings/);
    expect(copy.startAgainHint).toMatch(/fresh transcript/);
    expect(`${copy.title} ${copy.reassurance}`).not.toMatch(/worth suggesting|strong moment/);
  });

  // The start form never mentions credits and a new link run transcribes by
  // itself, so a card that says nothing about cost reads as free — beside
  // "No credits were used" on the upload card, especially.
  it("says a fresh transcript uses credits", () => {
    expect(safeErrorCopy("repurpose/transcript_untimed").startAgainHint).toMatch(
      /fresh transcript, which uses credits like any new video/,
    );
  });

  // An upload run has no "Start again" to offer (its card leads with another
  // video), so a reassurance that said "starting again with the same video
  // makes a fresh transcript" described a button that was not there. That
  // promise lives in `startAgainHint`, shown only beside the button.
  it("keeps every promise about starting again out of the reassurance", () => {
    for (const [code, copy] of Object.entries(SAFE_ERROR_COPY)) {
      if (copy.action !== "start_again") continue;
      expect(copy.reassurance, code).not.toMatch(/\bstart(ing)? again\b/i);
    }
  });

  // `canRetry: false` (a deleted source, an unreadable upload) takes "Try
  // again" off the card, so a reassurance that promised it would be wrong
  // there. That promise lives in `retryHint`, shown only beside the button.
  it("keeps every promise that trying again helps out of the reassurance", () => {
    for (const [code, copy] of Object.entries(SAFE_ERROR_COPY)) {
      expect(copy.reassurance, code).not.toMatch(/\btry(ing)? again\b/i);
    }
    expect(safeErrorCopy("repurpose/source_unavailable").retryHint).toMatch(/try again/);
    expect(safeErrorCopy("repurpose/source_blocked").retryHint).toMatch(/few minutes/);
    expect(safeErrorCopy("repurpose/stage_timeout").retryHint).toMatch(/Trying again/);
    expect(safeErrorCopy("repurpose/no_credits").retryHint).toMatch(/once you have enough/);
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
    // The `media.clip` worker's own codes (its tool failures included), the job
    // ledger's, the clip project's media check, and the API's own "the
    // original is gone" and "the cut stopped responding" — none of them may
    // fall through to the catch-all.
    for (const code of [
      "media/unreadable",
      "media/corrupt",
      "media/source_unavailable",
      "media/encode_failed",
      "media/encode_incomplete",
      "media/source_missing",
      "media/tool_timeout",
      "media/tool_signal",
      "media/tool_spawn",
      "media/cancelled",
      "media/unsupported",
      "media/no_streams",
      "media/probe_failed",
      "media/too_large",
      "media/too_long",
      "jobs/queue_timeout",
      "jobs/cancelled",
      "repurpose/source_expired",
      "repurpose/clip_stalled",
    ]) {
      expect(Object.hasOwn(CLIP_FAILURE_COPY, code), code).toBe(true);
    }
  });

  // The API defined `repurpose/clip_stalled` as a clip state and the card
  // said "This clip could not be made". Read the codes from their sources, as
  // the run codes are read from the contract, so a new one fails here first.
  it("has copy for every code the API's clip state and the worker's tool failures produce", () => {
    const dto = readFileSync(
      join(__dirname, "../../../api/src/repurpose/repurpose-clips.dto.ts"),
      "utf8",
    );
    const clipErrors = new Map(
      [...dto.matchAll(/^\s*(\w+): "(repurpose\/[a-z_]+)",\r?$/gm)].map(
        (match) => [match[1] ?? "", match[2] ?? ""] as const,
      ),
    );
    const clipState = readFileSync(
      join(__dirname, "../../../api/src/repurpose/clip-state.ts"),
      "utf8",
    );
    const stateNames = [...clipState.matchAll(/REPURPOSE_CLIP_ERRORS\.(\w+)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(stateNames).toContain("cutStalled");

    const clipWorker = readFileSync(
      join(__dirname, "../../../worker-media/src/processors/clip.ts"),
      "utf8",
    );
    const toolBlock = /const TOOL_FAILURES[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(clipWorker)?.[1];
    if (toolBlock === undefined) throw new Error("TOOL_FAILURES not found in the clip worker");
    const toolCodes = [...toolBlock.matchAll(/"(media\/[a-z_]+)"/g)].map((match) => match[1] ?? "");
    expect(toolCodes.length).toBeGreaterThanOrEqual(4);

    for (const code of [...stateNames.map((name) => clipErrors.get(name) ?? name), ...toolCodes]) {
      expect(Object.hasOwn(CLIP_FAILURE_COPY, code), code).toBe(true);
      expect(clipFailureCopy(code).title, code).not.toBe("This clip could not be made");
    }
  });

  // The clip's failure code is also its project's media failure reason
  // (`clipStateOf`), and the API's clip completion writes `media/too_large`
  // there itself — which fell through to "This clip could not be made" with a
  // retry that cuts the same size again. Every reason the worker can report and
  // the API accepts is read from both lists, as the run codes are read from the
  // contract; the download-only `media/source_*` reasons never reach a clip.
  it("has copy for every media failure reason a clip's own media can carry", () => {
    const reasonsIn = (source: string, where: string): string[] => {
      const block = /export const MEDIA_FAILURE_REASONS = \[([\s\S]*?)\] as const;/.exec(
        source,
      )?.[1];
      if (block === undefined) throw new Error(`MEDIA_FAILURE_REASONS not found in ${where}`);
      return [...block.matchAll(/"(media\/[a-z_]+)"/g)].map((match) => match[1] ?? "");
    };
    const worker = reasonsIn(
      readFileSync(join(__dirname, "../../../worker-media/src/errors.ts"), "utf8"),
      "the media worker",
    );
    const api = reasonsIn(
      readFileSync(join(__dirname, "../../../api/src/media/media.constants.ts"), "utf8"),
      "the API",
    );
    expect(worker).toContain("media/too_large");
    expect(api).toContain("media/too_large");

    const reasons = [...new Set([...worker, ...api])].filter(
      (code) => !code.startsWith("media/source_"),
    );
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    for (const code of reasons) {
      expect(Object.hasOwn(CLIP_FAILURE_COPY, code), code).toBe(true);
      expect(clipFailureCopy(code).title, code).not.toBe("This clip could not be made");
    }
  });

  it("offers no retry for a clip that came out too large, and says a shorter moment fits", () => {
    const copy = clipFailureCopy("media/too_large");
    expect(copy.title).toBe("This clip came out too large to open in the editor");
    expect(copy.reassurance).toMatch(/shorter moment/);
    expect(copy.retryable).toBe(false);
    // The same moment from the same video comes out the same size again.
    expect(copy.startAgain).not.toBe(true);
  });

  it("says a stalled cut stopped partway, and that trying again starts it afresh", () => {
    const copy = clipFailureCopy("repurpose/clip_stalled");
    expect(copy.title).toBe("This clip stopped partway through");
    expect(copy.reassurance).toMatch(/starts it afresh/);
    expect(copy.retryable).toBe(true);
  });

  it("gives a refused create on a moment's own card the reason it really has: a stopped run", () => {
    expect(REFUSAL_COPY.clip["repurpose/run_not_ready"]).toMatch(/stopped/);
  });

  it("offers no retry when the original video is gone, since it would only be refused", () => {
    expect(clipFailureCopy("repurpose/source_expired").retryable).toBe(false);
    expect(clipFailureCopy("media/source_missing").retryable).toBe(false);
    // A new run gets the original afresh, so that is offered instead. Said as
    // "the same video", since an upload run's original expires too.
    expect(clipFailureCopy("repurpose/source_expired").startAgain).toBe(true);
    expect(clipFailureCopy("media/source_missing").startAgain).toBe(true);
    expect(clipFailureCopy("repurpose/source_expired").reassurance).not.toMatch(/link/);
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
        copy.retryHint ?? "",
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
