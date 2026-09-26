import { HttpStatus } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

import {
  RepurposeReconciler,
  acquireCeilingMs,
  decideRunAction,
  isStalled,
  planRetry,
  stalledJobIds,
  workCeilingMs,
  youtubeUrlOf,
} from "./reconciler.js";
import {
  ACQUIRE_RUNNING_MARGIN_MS,
  ACQUIRE_TIMEOUT_MS,
  DEFAULT_RECONCILE_WATCHDOG_MS,
  QUEUE_DOWN_BACKOFF_MS,
  RECONCILE_INTERVAL_MS,
  STAGE_RUNNING_BASE_MS,
  UPLOAD_WINDOW_MS,
  reconcileWatchdogIntervalMs,
} from "./repurpose.constants.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";

import type { JobFacts, RunSnapshot } from "./reconciler.js";
import type { RepurposeClipsService } from "./repurpose-clips.service.js";
import type { RepurposeService } from "./repurpose.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";
import type { RepurposeRun } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const FRESH_MEDIA = "01JCMED1A0000000000000000B";
const RUN = "01JCRN0000000000000000000A";
const TRANSCRIPT = "01JCTRANSCR1PT000000000000";
const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const FIRST_KEY = `media.acquire:${RUN}:youtube:dQw4w9WgXcQ`;

/**
 * "Now" for every test. A job's age is measured against the clock, and the fake
 * jobs below are stamped from 10:00, so the real clock would read every running
 * one as stalled on any afternoon.
 */
const NOW = Date.parse("2026-09-26T10:30:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The decision (§1's table), as a pure function
// ---------------------------------------------------------------------------

const live: JobFacts = { status: "running", errorCode: null, started: true };
const done: JobFacts = { status: "succeeded", errorCode: null, started: true };
const failedWith = (errorCode: string | null): JobFacts => ({
  status: "failed",
  errorCode,
  started: true,
});

/** A job that has been `running` since `minutesAgo` before {@link NOW}. */
const runningFor = (minutesAgo: number, extra: Partial<JobFacts> = {}): JobFacts => ({
  id: "01JCJ0BSTALE00000000000000",
  status: "running",
  errorCode: null,
  started: true,
  queuedAt: NOW - minutesAgo * MINUTE - 1_000,
  startedAt: NOW - minutesAgo * MINUTE,
  maxQueueWaitMs: 30 * MINUTE,
  ...extra,
});

/** A job still `queued` since `minutesAgo`, under the Free plan's 30-minute queue wait. */
const queuedFor = (minutesAgo: number): JobFacts => ({
  id: "01JCJ0BQUEUED0000000000000",
  status: "queued",
  errorCode: null,
  started: false,
  queuedAt: NOW - minutesAgo * MINUTE,
  startedAt: null,
  maxQueueWaitMs: 30 * MINUTE,
});

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    now: NOW,
    sourceRequestedAt: NOW - 90 * MINUTE,
    sourceKind: "youtube_url",
    sourceDeleted: false,
    media: { status: "pending", failureReason: null, arrived: false, durationMs: null },
    acquireJob: live,
    processingJob: null,
    canRefetch: true,
    transcriptId: null,
    transcribeJob: null,
    highlightsJob: null,
    candidateCount: 0,
    ...overrides,
  };
}

const readyMedia = {
  status: "ready",
  failureReason: null,
  arrived: true,
  durationMs: 600_000,
} as const;

describe("decideRunAction — getting the video", () => {
  it("waits while the download is queued or running", () => {
    expect(decideRunAction(snapshot())).toEqual({ kind: "wait" });
  });

  it("fails a terminal download with the code for the worker's reason", () => {
    const action = decideRunAction(
      snapshot({
        media: {
          status: "failed",
          failureReason: "media/too_large",
          arrived: false,
          durationMs: null,
        },
        acquireJob: failedWith("media/unreadable"),
      }),
    );
    expect(action).toEqual({
      kind: "fail",
      failedAt: "acquire",
      code: "repurpose/source_too_large",
    });
  });

  it("fails as soon as the media says so, before the job is reported", () => {
    const action = decideRunAction(
      snapshot({
        media: {
          status: "failed",
          failureReason: "media/source_blocked",
          arrived: false,
          durationMs: null,
        },
        acquireJob: live,
      }),
    );
    expect(action).toMatchObject({ kind: "fail", code: "repurpose/source_blocked" });
  });

  it("fails a download that ended without a reason as 'could not get it'", () => {
    const action = decideRunAction(snapshot({ acquireJob: failedWith("jobs/queue_timeout") }));
    expect(action).toMatchObject({ kind: "fail", code: "repurpose/source_unavailable" });
  });

  it("fetches again into a pending row that nothing is fetching into", () => {
    expect(decideRunAction(snapshot({ acquireJob: null }))).toEqual({ kind: "acquire" });
  });

  it("treats a job the queue refused as never started, not as a failure", () => {
    const refused: JobFacts = {
      status: "failed",
      errorCode: ERROR_CODES.unavailable,
      started: false,
    };
    expect(decideRunAction(snapshot({ acquireJob: refused }))).toEqual({ kind: "acquire" });
  });

  it("waits when there is no address to fetch from yet (create is mid-way)", () => {
    expect(decideRunAction(snapshot({ acquireJob: null, canRefetch: false }))).toEqual({
      kind: "wait",
    });
  });

  it("waits for an upload whose browser has not asked for a ticket", () => {
    expect(decideRunAction(snapshot({ sourceKind: "upload", media: null }))).toEqual({
      kind: "wait",
    });
  });

  it("fails a run whose source project was deleted, whatever stage it was at", () => {
    // Nothing can be fetched into, transcribed or looked through any more; it
    // used to wait on "Getting your video" for good, retrying every read.
    for (const overrides of [
      {},
      { media: readyMedia, acquireJob: done },
      { media: readyMedia, acquireJob: done, transcriptId: TRANSCRIPT },
    ]) {
      expect(decideRunAction(snapshot({ ...overrides, sourceDeleted: true }))).toEqual({
        kind: "fail",
        failedAt: "acquire",
        code: "repurpose/source_unavailable",
      });
    }
  });
});

describe("decideRunAction — after the download", () => {
  it.each([
    ["media/too_long", "repurpose/source_too_long"],
    ["media/probe_failed", "repurpose/processing_failed"],
    ["media/corrupt", "repurpose/processing_failed"],
  ])("fails media that failed after arriving (%s) as %s", (reason, code) => {
    const action = decideRunAction(
      snapshot({
        media: { status: "failed", failureReason: reason, arrived: true, durationMs: null },
        acquireJob: done,
      }),
    );
    expect(action).toEqual({ kind: "fail", failedAt: "processing", code });
  });

  it("treats an upload that failed as a processing failure", () => {
    const action = decideRunAction(
      snapshot({
        sourceKind: "upload",
        media: {
          status: "failed",
          failureReason: "media/unsupported",
          arrived: true,
          durationMs: null,
        },
        acquireJob: null,
      }),
    );
    expect(action).toMatchObject({ kind: "fail", code: "repurpose/processing_failed" });
  });

  it("waits while the media is being probed and prepared", () => {
    for (const status of ["uploaded", "probing"] as const) {
      const action = decideRunAction(
        snapshot({ media: { ...readyMedia, status }, acquireJob: done, processingJob: live }),
      );
      expect(action, status).toEqual({ kind: "wait" });
    }
  });

  it("fails media whose probe or proxy ended with nothing written back", () => {
    // The probe has no failure handler: a failed probe left the media
    // `uploaded` and the run on "Getting your video" for good.
    for (const status of ["uploaded", "probing"] as const) {
      for (const sourceKind of ["youtube_url", "upload"] as const) {
        const action = decideRunAction(
          snapshot({
            sourceKind,
            media: { ...readyMedia, status },
            acquireJob: sourceKind === "upload" ? null : done,
            processingJob: failedWith("media/probe_failed"),
          }),
        );
        expect(action, `${sourceKind} ${status}`).toEqual({
          kind: "fail",
          failedAt: "processing",
          code: "repurpose/processing_failed",
        });
      }
    }
  });

  it("keeps waiting when the probe was only refused by the queue", () => {
    const refused: JobFacts = {
      status: "failed",
      errorCode: ERROR_CODES.unavailable,
      started: false,
    };
    expect(
      decideRunAction(
        snapshot({
          media: { ...readyMedia, status: "uploaded" },
          acquireJob: done,
          processingJob: refused,
        }),
      ),
    ).toEqual({ kind: "wait" });
  });

  it("starts the transcription when ready media has none and nothing is making one", () => {
    expect(decideRunAction(snapshot({ media: readyMedia, acquireJob: done }))).toEqual({
      kind: "transcribe",
    });
  });

  it("waits while the transcription is running", () => {
    expect(
      decideRunAction(snapshot({ media: readyMedia, acquireJob: done, transcribeJob: live })),
    ).toEqual({ kind: "wait" });
  });

  it("fails a transcription that failed, and names a lack of credits as such", () => {
    expect(
      decideRunAction(
        snapshot({ media: readyMedia, acquireJob: done, transcribeJob: failedWith("asr/failed") }),
      ),
    ).toEqual({ kind: "fail", failedAt: "transcription", code: "repurpose/transcription_failed" });
    expect(
      decideRunAction(
        snapshot({
          media: readyMedia,
          acquireJob: done,
          transcribeJob: failedWith("credits/insufficient"),
        }),
      ),
    ).toMatchObject({ kind: "fail", code: "repurpose/no_credits" });
  });
});

describe("decideRunAction — finding moments", () => {
  const transcribed = { media: readyMedia, acquireJob: done, transcriptId: TRANSCRIPT } as const;

  it("starts discovery for a transcript nothing is looking at (the ten-day run)", () => {
    expect(decideRunAction(snapshot(transcribed))).toEqual({ kind: "discover" });
  });

  it("makes the state of the download irrelevant once a transcript exists", () => {
    const action = decideRunAction(
      snapshot({ ...transcribed, acquireJob: failedWith("media/unreadable") }),
    );
    expect(action).toEqual({ kind: "discover" });
  });

  it("waits while discovery runs", () => {
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: live }))).toEqual({
      kind: "wait",
    });
  });

  it("fails a discovery that failed with highlights_failed", () => {
    expect(
      decideRunAction(
        snapshot({ ...transcribed, highlightsJob: failedWith("jobs/queue_timeout") }),
      ),
    ).toEqual({ kind: "fail", failedAt: "highlights", code: "repurpose/highlights_failed" });
  });

  it("fails a discovery that found the transcript has no timings with its own code", () => {
    expect(
      decideRunAction(
        snapshot({ ...transcribed, highlightsJob: failedWith("worker/transcript_untimed") }),
      ),
    ).toEqual({ kind: "fail", failedAt: "highlights", code: "repurpose/transcript_untimed" });
  });

  it("looks again when a finished discovery's result was turned away", () => {
    // Applied results move the run in the same transaction; a succeeded job with
    // the run still finding means the result never landed.
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: done }))).toEqual({
      kind: "discover",
    });
  });

  it("moves on when a finished discovery's moments are already stored", () => {
    expect(
      decideRunAction(snapshot({ ...transcribed, highlightsJob: done, candidateCount: 3 })),
    ).toEqual({ kind: "candidates_ready" });
  });
});

describe("decideRunAction — a step that stopped making progress", () => {
  // `readyMedia` is ten minutes long: the ceiling is an hour plus twenty minutes.
  const transcribed = { media: readyMedia, acquireJob: done, transcriptId: TRANSCRIPT } as const;
  const timedOut = (failedAt: string) => ({
    kind: "fail",
    failedAt,
    code: "repurpose/stage_timeout",
  });

  it("fails discovery still running long past the point it could finish", () => {
    // It used to wait on "Finding promising moments" for good: a worker that
    // died, or a report lost to an API restart, leaves the job `running`.
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: runningFor(81) }))).toEqual(
      timedOut("highlights"),
    );
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: runningFor(79) }))).toEqual({
      kind: "wait",
    });
  });

  it("fails discovery still queued past the plan's queue wait: nothing is taking it", () => {
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: queuedFor(31) }))).toEqual(
      timedOut("highlights"),
    );
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: queuedFor(29) }))).toEqual({
      kind: "wait",
    });
  });

  it("fails a transcription a worker lost", () => {
    const ready = { media: readyMedia, acquireJob: done } as const;
    expect(decideRunAction(snapshot({ ...ready, transcribeJob: runningFor(81) }))).toEqual(
      timedOut("transcription"),
    );
    expect(decideRunAction(snapshot({ ...ready, transcribeJob: runningFor(79) }))).toEqual({
      kind: "wait",
    });
  });

  it("gives a longer video longer", () => {
    // Two hours of video: an hour plus four.
    const long = { media: { ...readyMedia, durationMs: 120 * MINUTE }, acquireJob: done } as const;
    expect(decideRunAction(snapshot({ ...long, transcribeJob: runningFor(299) }))).toEqual({
      kind: "wait",
    });
    expect(decideRunAction(snapshot({ ...long, transcribeJob: runningFor(301) }))).toEqual(
      timedOut("transcription"),
    );
  });

  it("fails a download still running long after its own deadline", () => {
    // A forty-minute deadline in its payload, and ten minutes' margin.
    expect(
      decideRunAction(snapshot({ acquireJob: runningFor(51, { timeoutMs: 40 * MINUTE }) })),
    ).toEqual(timedOut("acquire"));
    expect(
      decideRunAction(snapshot({ acquireJob: runningFor(49, { timeoutMs: 40 * MINUTE }) })),
    ).toEqual({ kind: "wait" });
  });

  it("fails a download still queued past the plan's queue wait: the acquisition worker is not consuming", () => {
    expect(decideRunAction(snapshot({ acquireJob: queuedFor(31) }))).toEqual(timedOut("acquire"));
  });

  it("fails a probe or proxy still running long past the point it could finish", () => {
    // Nothing measured yet, so the ceiling is the hour alone.
    for (const sourceKind of ["youtube_url", "upload"] as const) {
      const action = decideRunAction(
        snapshot({
          sourceKind,
          media: { ...readyMedia, status: "probing", durationMs: null },
          acquireJob: sourceKind === "upload" ? null : done,
          processingJob: runningFor(61),
        }),
      );
      expect(action, sourceKind).toEqual(timedOut("processing"));
    }
  });

  it("never reads a job it has no timings for as stalled", () => {
    expect(decideRunAction(snapshot({ ...transcribed, highlightsJob: live }))).toEqual({
      kind: "wait",
    });
  });
});

describe("isStalled, the ceilings and stalledJobIds", () => {
  it("measures a running job from when a worker started it, else from when it was queued", () => {
    expect(isStalled(runningFor(61), 60 * MINUTE, NOW)).toBe(true);
    expect(isStalled(runningFor(59), 60 * MINUTE, NOW)).toBe(false);
    expect(
      isStalled(
        { ...runningFor(0), startedAt: null, queuedAt: NOW - 61 * MINUTE },
        60 * MINUTE,
        NOW,
      ),
    ).toBe(true);
  });

  it("never reads a finished job, or a queued one with no queue wait, as stalled", () => {
    expect(isStalled({ ...runningFor(600), status: "succeeded" }, MINUTE, NOW)).toBe(false);
    expect(isStalled({ ...runningFor(600), status: "failed" }, MINUTE, NOW)).toBe(false);
    expect(isStalled({ ...queuedFor(600), maxQueueWaitMs: null }, MINUTE, NOW)).toBe(false);
  });

  it("gives a download its own deadline plus a margin, and the rest an hour plus twice the video", () => {
    expect(acquireCeilingMs({ ...live, timeoutMs: 20 * MINUTE })).toBe(
      20 * MINUTE + ACQUIRE_RUNNING_MARGIN_MS,
    );
    expect(acquireCeilingMs(live)).toBe(ACQUIRE_TIMEOUT_MS + ACQUIRE_RUNNING_MARGIN_MS);
    expect(workCeilingMs(null)).toBe(STAGE_RUNNING_BASE_MS);
    expect(workCeilingMs(10 * MINUTE)).toBe(STAGE_RUNNING_BASE_MS + 20 * MINUTE);
  });

  it("names the stalled jobs among those the run read, and only those", () => {
    expect(
      stalledJobIds(
        snapshot({
          media: readyMedia,
          acquireJob: { ...done, id: "ACQUIRE" },
          transcribeJob: runningFor(81, { id: "TRANSCRIBE" }),
        }),
      ),
    ).toEqual(["TRANSCRIBE"]);
    expect(
      stalledJobIds(
        snapshot({ media: readyMedia, acquireJob: done, transcribeJob: runningFor(10) }),
      ),
    ).toEqual([]);
  });

  it("leaves the media's probe or proxy out when asked to (the fail path), and names it otherwise", () => {
    // They free nothing, and a late probe is the only way an upload gets prepared.
    const preparing = snapshot({
      sourceKind: "upload",
      media: { ...readyMedia, status: "uploaded", durationMs: null },
      acquireJob: null,
      processingJob: { ...queuedFor(45), id: "PROBE" },
    });
    expect(stalledJobIds(preparing, { preparation: false })).toEqual([]);
    expect(stalledJobIds(preparing)).toEqual(["PROBE"]);
  });
});

describe("decideRunAction — an upload that never arrived", () => {
  const dayOld = { sourceRequestedAt: NOW - UPLOAD_WINDOW_MS - MINUTE } as const;
  const notArrived = (status: "pending" | "uploading") =>
    ({ status, failureReason: null, arrived: false, durationMs: null }) as const;

  it("fails an upload run still without its file a day after it was asked for", () => {
    // No row (the upload never started, or matched a file already in the
    // workspace), or one stuck mid-upload (failed and dismissed).
    for (const media of [null, notArrived("pending"), notArrived("uploading")]) {
      expect(
        decideRunAction(snapshot({ ...dayOld, sourceKind: "upload", media, acquireJob: null })),
        media?.status ?? "no row",
      ).toEqual({ kind: "fail", failedAt: "acquire", code: "repurpose/upload_missing" });
    }
  });

  it("keeps waiting inside the window: the browser's upload queue resumes a closed tab", () => {
    expect(
      decideRunAction(
        snapshot({
          sourceKind: "upload",
          media: notArrived("uploading"),
          acquireJob: null,
          sourceRequestedAt: NOW - UPLOAD_WINDOW_MS + MINUTE,
        }),
      ),
    ).toEqual({ kind: "wait" });
  });

  it("leaves a file that arrived to its preparation, however long ago it was asked for", () => {
    expect(
      decideRunAction(
        snapshot({
          ...dayOld,
          sourceKind: "upload",
          media: { ...readyMedia, status: "probing" },
          acquireJob: null,
          processingJob: live,
        }),
      ),
    ).toEqual({ kind: "wait" });
  });

  it("never applies to a link, whose download has a deadline of its own", () => {
    expect(decideRunAction(snapshot({ ...dayOld }))).toEqual({ kind: "wait" });
  });
});

describe("planRetry", () => {
  it("goes back to the moments a run already has", () => {
    expect(
      planRetry(snapshot({ transcriptId: TRANSCRIPT, candidateCount: 2 }), {
        failureCode: "repurpose/clip_failed",
      }),
    ).toEqual({ kind: "restore" });
  });

  it("looks for moments again after a discovery failure, even with some stored", () => {
    for (const failureCode of ["repurpose/highlights_failed", "repurpose/analysis_failed"]) {
      expect(
        planRetry(snapshot({ transcriptId: TRANSCRIPT, candidateCount: 2 }), { failureCode }),
        failureCode,
      ).toEqual({ kind: "discover" });
    }
  });

  it("restarts the transcription for ready media with no transcript", () => {
    expect(
      planRetry(snapshot({ media: readyMedia, transcribeJob: failedWith("asr/failed") }), {
        failureCode: "repurpose/transcription_failed",
      }),
    ).toEqual({ kind: "transcribe" });
  });

  it("fetches the link again into a fresh row after a failed download", () => {
    expect(
      planRetry(
        snapshot({
          media: {
            status: "failed",
            failureReason: "media/source_blocked",
            arrived: false,
            durationMs: null,
          },
          acquireJob: failedWith("media/source_blocked"),
        }),
        { failureCode: "repurpose/source_blocked" },
      ),
    ).toEqual({ kind: "acquire", reuseMedia: false });
  });

  it("fetches into the pending row a refused enqueue left behind", () => {
    expect(
      planRetry(snapshot({ acquireJob: null }), { failureCode: "repurpose/stage_timeout" }),
    ).toEqual({
      kind: "acquire",
      reuseMedia: true,
    });
  });

  it("does not start a second download while the first is still running", () => {
    expect(
      planRetry(snapshot({ acquireJob: live }), { failureCode: "repurpose/stage_timeout" }),
    ).toEqual({ kind: "resume" });
  });

  it("fetches again when the media failed but the download's report was lost", () => {
    // The worker marked the media failed, then its /complete never landed (an
    // API restart), so the job still reads `running`. "Resume" reopened the run
    // and the next read failed it again from the media, on every Retry.
    expect(
      planRetry(
        snapshot({
          media: {
            status: "failed",
            failureReason: "media/source_blocked",
            arrived: false,
            durationMs: null,
          },
          acquireJob: live,
        }),
        { failureCode: "repurpose/source_blocked" },
      ),
    ).toEqual({ kind: "acquire", reuseMedia: false });
  });

  it("refuses a run whose source project was deleted", () => {
    expect(
      planRetry(snapshot({ sourceDeleted: true, transcriptId: TRANSCRIPT }), {
        failureCode: "repurpose/source_unavailable",
      }),
    ).toMatchObject({ kind: "impossible" });
  });

  it("refuses an upload whose preparation ended, rather than resuming into the same failure", () => {
    expect(
      planRetry(
        snapshot({
          sourceKind: "upload",
          media: { ...readyMedia, status: "uploaded" },
          acquireJob: null,
          processingJob: failedWith("media/probe_failed"),
        }),
        { failureCode: "repurpose/processing_failed" },
      ),
    ).toMatchObject({ kind: "impossible" });
  });

  it("refuses an upload whose preparation stalled while it is still open, then transcribes once it lands", () => {
    const stalled = {
      sourceKind: "upload",
      acquireJob: null,
      processingJob: queuedFor(45),
    } as const;
    const refused = planRetry(
      snapshot({ ...stalled, media: { ...readyMedia, status: "uploaded", durationMs: null } }),
      { failureCode: "repurpose/stage_timeout" },
    );
    // Not "could not be read": nothing says the file is at fault.
    expect(refused).toEqual({
      kind: "impossible",
      reason:
        "This file is still waiting to be prepared. Try again once it has been, or upload it again.",
    });
    // The worker came back and the probe ran late: the same run can go on.
    expect(
      planRetry(snapshot({ ...stalled, processingJob: null, media: readyMedia }), {
        failureCode: "repurpose/stage_timeout",
      }),
    ).toEqual({ kind: "transcribe" });
  });

  it("fetches a link again into a fresh row when its preparation ended", () => {
    expect(
      planRetry(
        snapshot({
          media: { ...readyMedia, status: "probing" },
          acquireJob: done,
          processingJob: failedWith("media/probe_failed"),
        }),
        { failureCode: "repurpose/processing_failed" },
      ),
    ).toEqual({ kind: "acquire", reuseMedia: false });
  });

  it("refuses a link whose address was never kept", () => {
    expect(
      planRetry(snapshot({ acquireJob: failedWith(null), canRefetch: false }), {
        failureCode: "repurpose/source_unavailable",
      }),
    ).toMatchObject({ kind: "impossible" });
  });

  it("refuses a run whose transcript has no timings: looking again reads the same words", () => {
    expect(
      planRetry(snapshot({ media: readyMedia, acquireJob: done, transcriptId: TRANSCRIPT }), {
        failureCode: "repurpose/transcript_untimed",
      }),
    ).toMatchObject({ kind: "impossible" });
  });

  it("refuses an upload that never arrived: nothing on the run can send it", () => {
    const upload = { sourceKind: "upload", media: null, acquireJob: null } as const;
    expect(planRetry(snapshot(upload), { failureCode: "repurpose/upload_missing" })).toMatchObject({
      kind: "impossible",
    });
    // Whatever it failed with, once the window has passed.
    expect(
      planRetry(snapshot({ ...upload, sourceRequestedAt: NOW - UPLOAD_WINDOW_MS - MINUTE }), {
        failureCode: "repurpose/stage_timeout",
      }),
    ).toMatchObject({ kind: "impossible" });
    // Inside it, a timed-out run still goes back to waiting for the file.
    expect(planRetry(snapshot(upload), { failureCode: "repurpose/stage_timeout" })).toEqual({
      kind: "resume",
    });
  });

  it("fetches again, rather than resuming, a download open long past its own deadline", () => {
    // "Resume" would watch a download nothing is running, for good.
    expect(
      planRetry(snapshot({ acquireJob: runningFor(51, { timeoutMs: 40 * MINUTE }) }), {
        failureCode: "repurpose/stage_timeout",
      }),
    ).toEqual({ kind: "acquire", reuseMedia: true });
  });

  it("refuses an upload that could not be read: only a new upload helps", () => {
    expect(
      planRetry(
        snapshot({
          sourceKind: "upload",
          media: {
            status: "failed",
            failureReason: "media/corrupt",
            arrived: true,
            durationMs: null,
          },
          acquireJob: null,
        }),
        { failureCode: "repurpose/processing_failed" },
      ),
    ).toMatchObject({ kind: "impossible" });
  });
});

// ---------------------------------------------------------------------------
// The reconciler against a small in-memory database
// ---------------------------------------------------------------------------

interface FakeJob {
  id: string;
  type: string;
  jobKey: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  queuedAt: Date;
  maxQueueWaitMs: number | null;
  params: Record<string, unknown>;
}

interface World {
  run: RepurposeRun;
  project: {
    deletedAt: Date | null;
    createdBy: string | null;
    sourceLanguage: string | null;
  } | null;
  media: {
    id: string;
    bucket: "s3";
    storageKey: string;
    status: string;
    failureReason: string | null;
    uploadedAt: Date | null;
    durationMs: number | null;
    createdAt: Date;
  } | null;
  transcript: { id: string } | null;
  candidates: number;
  readyClips: number;
  balanceTenths: number;
  jobs: FakeJob[];
}

let clock = Date.parse("2026-09-26T10:00:00Z");

/** A distinct job id per fake job. */
function jobId(): string {
  return `01JCJ0B${String(clock).padStart(19, "0")}`;
}

function acquireJob(overrides: Partial<FakeJob> = {}, mediaId = MEDIA): FakeJob {
  clock += 1_000;
  return {
    id: jobId(),
    maxQueueWaitMs: 30 * MINUTE,
    type: "media.acquire",
    jobKey: FIRST_KEY,
    projectId: PROJECT,
    status: "running",
    error: null,
    startedAt: new Date(clock),
    finishedAt: null,
    queuedAt: new Date(clock),
    params: {
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: RUN,
      projectId: PROJECT,
      mediaId,
      source: { kind: "youtube_url", normalizedUrl: URL, sourceId: "youtube:dQw4w9WgXcQ" },
      destination: { bucket: "s3", key: `ws/${WS}/p/${PROJECT}/media/${mediaId}/raw.mp4` },
      limits: { maxBytes: 524_288_000, maxDurationMs: 1_200_000, timeoutMs: 2_400_000 },
    },
    ...overrides,
  };
}

function job(type: string, jobKey: string, overrides: Partial<FakeJob> = {}): FakeJob {
  clock += 1_000;
  return {
    id: jobId(),
    maxQueueWaitMs: 30 * MINUTE,
    type,
    jobKey,
    projectId: PROJECT,
    status: "running",
    error: null,
    startedAt: new Date(clock),
    finishedAt: null,
    queuedAt: new Date(clock),
    params: { mediaId: MEDIA, runId: RUN },
    ...overrides,
  };
}

function runRow(overrides: Partial<RepurposeRun> = {}): RepurposeRun {
  return {
    id: RUN,
    workspaceId: WS,
    sourceProjectId: PROJECT,
    sourceKind: "youtube_url",
    sourceFingerprint: "youtube:dQw4w9WgXcQ",
    mode: "ai",
    status: "draft",
    currentStage: "getting_video",
    progress: 0,
    failureCode: null,
    completedAt: null,
    // Before every fake job: the run was last written when it was created.
    createdAt: new Date("2026-09-26T09:00:00Z"),
    updatedAt: new Date("2026-09-26T09:00:00Z"),
    ...overrides,
  } as RepurposeRun;
}

function world(overrides: Partial<World> = {}): World {
  return {
    run: runRow(),
    project: {
      deletedAt: null,
      createdBy: "01JCUSER000000000000000000",
      sourceLanguage: "hi-Latn",
    },
    media: {
      id: MEDIA,
      bucket: "s3",
      storageKey: `ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`,
      status: "pending",
      failureReason: null,
      uploadedAt: null,
      durationMs: null,
      createdAt: new Date("2026-09-26T09:00:00Z"),
    },
    transcript: null,
    candidates: 0,
    readyClips: 0,
    balanceTenths: 1_000,
    jobs: [acquireJob()],
    ...overrides,
  };
}

function matchesStatus(status: string, where: unknown): boolean {
  if (where === undefined) return true;
  if (typeof where === "string") return status === where;
  const set = (where as { in?: readonly string[] }).in;
  return set === undefined || set.includes(status);
}

/** A string column filter as the reconciler writes them: equals, `in` or `startsWith`. */
function matchesText(value: string, where: unknown): boolean {
  if (where === undefined) return true;
  if (typeof where === "string") return value === where;
  const filter = where as { in?: readonly string[]; startsWith?: string };
  if (filter.in !== undefined) return filter.in.includes(value);
  if (filter.startsWith !== undefined) return value.startsWith(filter.startsWith);
  return true;
}

interface JobQuery {
  where: {
    type: unknown;
    projectId?: string;
    jobKey?: unknown;
    finishedAt?: { gte: Date };
  };
  orderBy?: { queuedAt?: "desc"; finishedAt?: "desc" };
  take: number;
}

function fakePrisma(w: World) {
  const findJobs = vi.fn(async (args: JobQuery) => {
    const byFinish = args.orderBy?.finishedAt !== undefined;
    return w.jobs
      .filter(
        (row) =>
          matchesText(row.type, args.where.type) &&
          (args.where.projectId === undefined || row.projectId === args.where.projectId) &&
          matchesText(row.jobKey, args.where.jobKey) &&
          (args.where.finishedAt === undefined ||
            (row.finishedAt !== null && row.finishedAt >= args.where.finishedAt.gte)),
      )
      .sort((a, b) =>
        byFinish
          ? (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0)
          : b.queuedAt.getTime() - a.queuedAt.getTime(),
      )
      .slice(0, args.take);
  });
  const updateRun = vi.fn(
    async (args: { where: { id: string; status?: unknown }; data: Partial<RepurposeRun> }) => {
      if (!matchesStatus(w.run.status, args.where.status)) return { count: 0 };
      // `@updatedAt`, as Prisma stamps it on every write.
      clock += 1_000;
      w.run = { ...w.run, ...args.data, updatedAt: new Date(clock) } as RepurposeRun;
      return { count: 1 };
    },
  );
  return {
    findJobs,
    updateRun,
    prisma: {
      project: { findUnique: vi.fn(async () => w.project) },
      mediaAsset: { findFirst: vi.fn(async () => w.media) },
      transcript: { findFirst: vi.fn(async () => w.transcript) },
      clipCandidate: { count: vi.fn(async () => w.candidates) },
      repurposeClip: { count: vi.fn(async () => w.readyClips) },
      creditAccount: { findUnique: vi.fn(async () => ({ balanceTenths: w.balanceTenths })) },
      job: { findMany: findJobs },
      repurposeRun: {
        findUnique: vi.fn(async () => ({ ...w.run })),
        updateMany: updateRun,
        // The watchdog's listing: every run that has not settled.
        findMany: vi.fn(async (args: { where: { status: { notIn: readonly string[] } } }) =>
          args.where.status.notIn.includes(w.run.status) ? [] : [{ ...w.run }],
        ),
      },
    } as unknown as PrismaService,
  };
}

function harness(w: World) {
  const { prisma, findJobs, updateRun } = fakePrisma(w);
  const calls: string[] = [];
  const runs = {
    useReconciler: vi.fn(),
    publishStage: vi.fn(async () => undefined),
    failRun: vi.fn(async (run: RepurposeRun, code: string, stage: string) => {
      if (
        !["draft", "acquiring", "preparing_media", "transcribing", "analyzing"].includes(
          w.run.status,
        )
      ) {
        return null;
      }
      w.run = {
        ...w.run,
        status: "failed",
        failureCode: code,
        currentStage: stage,
      } as RepurposeRun;
      calls.push(`fail:${code}`);
      return { ...w.run };
    }),
    reacquire: vi.fn(async () => {
      calls.push(`reacquire:${w.run.status}`);
      return "01JCJ0B000000000000000000B";
    }),
    startHighlightDiscovery: vi.fn(
      async (
        run: RepurposeRun,
      ): Promise<{ outcome: "queued"; jobId: string } | { outcome: "deferred" }> => {
        calls.push(`discover:${w.run.status}`);
        return { outcome: "queued" as const, jobId: run.id };
      },
    ),
    duplicateOf: vi.fn(async (): Promise<AppException | null> => null),
    flagEnabled: vi.fn(async (_workspaceId: string, _flag: string) => true),
    // `JobsService.cancel`, and the one failure handler whose write the
    // reconciler reads back: a cancelled download marks its media failed.
    cancelJobs: vi.fn(async (run: RepurposeRun, ids: readonly string[]) => {
      for (const id of ids) {
        const row = w.jobs.find((candidate) => candidate.id === id);
        if (row === undefined || !["queued", "running"].includes(row.status)) continue;
        clock += 1_000;
        row.status = "cancelled";
        row.finishedAt = new Date(clock);
        row.error = { code: "jobs/cancelled" };
        calls.push(`cancel:${row.type}:${run.status}`);
        if (
          row.type === "media.acquire" &&
          w.media !== null &&
          ["pending", "uploading"].includes(w.media.status)
        ) {
          w.media = { ...w.media, status: "failed", failureReason: "media/source_failed" };
        }
      }
    }),
  };
  const autoTranscribe = {
    maybeEnqueue: vi.fn(async (): Promise<{ jobId: string } | undefined> => ({ jobId: "j" })),
  };
  const clips = { reconcileClips: vi.fn(async () => ({ enqueued: [] })) };
  const reconciler = new RepurposeReconciler(
    prisma,
    runs as unknown as RepurposeService,
    autoTranscribe as unknown as AutoTranscribeTrigger,
    clips as unknown as RepurposeClipsService,
  );
  return { reconciler, runs, autoTranscribe, clips, findJobs, updateRun, calls, prisma };
}

let w: World;
beforeEach(() => {
  w = world();
});

describe("RepurposeReconciler — wiring", () => {
  it("registers with the run service at boot", () => {
    const h = harness(w);
    h.reconciler.onModuleInit();
    expect(h.runs.useReconciler).toHaveBeenCalledWith(h.reconciler);
  });

  it("reconciles a read at most once per interval per run", async () => {
    const h = harness(w);
    // The shared clock: two hours on, the download it watches would have stalled.
    const now = NOW;
    await h.reconciler.reconcileIfDue(w.run, {}, now);
    const onePass = h.findJobs.mock.calls.length;
    expect(onePass).toBeGreaterThan(0);

    await h.reconciler.reconcileIfDue(w.run, {}, now + RECONCILE_INTERVAL_MS - 1);
    expect(h.findJobs).toHaveBeenCalledTimes(onePass);

    await h.reconciler.reconcileIfDue(w.run, {}, now + RECONCILE_INTERVAL_MS);
    expect(h.findJobs).toHaveBeenCalledTimes(onePass * 2);
  });

  it("never reads a settled run", async () => {
    for (const status of ["failed", "cancelled", "published", "partially_published"] as const) {
      const h = harness(world({ run: runRow({ status }) }));
      const out = await h.reconciler.reconcileIfDue(runRow({ status }));
      expect(out.status, status).toBe(status);
      expect(h.findJobs, status).not.toHaveBeenCalled();
    }
  });

  it("serves the run as it stands when reconciling fails", async () => {
    const h = harness(w);
    h.findJobs.mockRejectedValueOnce(new Error("database went away"));
    await expect(h.reconciler.reconcile(w.run)).resolves.toMatchObject({
      id: RUN,
      status: "draft",
    });
  });

  it("leaves a run that is reviewing its clips to its own page on a list read", async () => {
    // Fifty of those on every home-page poll was the pool's whole budget.
    for (const status of ["review_ready", "approved", "rendering"] as const) {
      w = world({ run: runRow({ status }) });
      const h = harness(w);
      await h.reconciler.reconcileIfDue(w.run, { forList: true });
      expect(h.clips.reconcileClips, status).not.toHaveBeenCalled();
      // Not stamped either: the run's own page still reconciles it at once.
      await h.reconciler.reconcileIfDue(w.run);
      expect(h.clips.reconcileClips, status).toHaveBeenCalledWith(RUN);
    }
  });

  it("still reconciles, on a list read, a run whose clips may be waiting for a slot", async () => {
    for (const status of ["materializing", "candidates_ready"] as const) {
      w = world({ run: runRow({ status }) });
      const h = harness(w);
      await h.reconciler.reconcileIfDue(w.run, { forList: true });
      expect(h.clips.reconcileClips, status).toHaveBeenCalledWith(RUN);
    }
  });

  it("backs off for a minute after the queue itself refused a download", async () => {
    // Every attempt while Redis is down leaves a dead job row behind.
    w.media = { ...w.media!, id: FRESH_MEDIA };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValue(
      new AppException(ERROR_CODES.unavailable, "queue down", HttpStatus.SERVICE_UNAVAILABLE),
    );
    const now = Date.parse("2026-09-26T12:00:00Z");

    await h.reconciler.reconcileIfDue(w.run, {}, now);
    expect(h.runs.reacquire).toHaveBeenCalledTimes(1);

    await h.reconciler.reconcileIfDue(w.run, {}, now + QUEUE_DOWN_BACKOFF_MS - 1);
    expect(h.runs.reacquire).toHaveBeenCalledTimes(1);

    await h.reconciler.reconcileIfDue(w.run, {}, now + QUEUE_DOWN_BACKOFF_MS);
    expect(h.runs.reacquire).toHaveBeenCalledTimes(2);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("does not back off after a full lane, which writes nothing", async () => {
    w.media = { ...w.media!, id: FRESH_MEDIA };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValue(
      new AppException("jobs/concurrency_cap", "busy", HttpStatus.TOO_MANY_REQUESTS),
    );
    const now = Date.parse("2026-09-26T12:00:00Z");
    await h.reconciler.reconcileIfDue(w.run, {}, now);
    await h.reconciler.reconcileIfDue(w.run, {}, now + RECONCILE_INTERVAL_MS);
    expect(h.runs.reacquire).toHaveBeenCalledTimes(2);
  });
});

describe("RepurposeReconciler — moving a run from durable state", () => {
  it("fails a run whose download failed, with the worker's reason", async () => {
    w.media = { ...w.media!, status: "failed", failureReason: "media/too_large" };
    w.jobs = [acquireJob({ status: "failed", error: { code: "media/unreadable" } })];
    const h = harness(w);

    const out = await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      "repurpose/source_too_large",
      "getting_video",
    );
    expect(out.status).toBe("failed");
  });

  it("fetches into a pending row whose download was never queued, from an earlier job's address", async () => {
    // A retry reserved a fresh row and the plan lane refused its fetch.
    w.media = { ...w.media!, id: FRESH_MEDIA };
    w.jobs = [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })];
    const h = harness(w);

    await h.reconciler.reconcile(w.run);
    expect(h.runs.reacquire).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      URL,
      expect.objectContaining({ id: FRESH_MEDIA }),
    );
  });

  it("keeps waiting, quietly, when that fetch is refused again", async () => {
    w.media = { ...w.media!, id: FRESH_MEDIA };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValueOnce(
      new AppException("jobs/concurrency_cap", "busy", HttpStatus.TOO_MANY_REQUESTS),
    );
    const out = await h.reconciler.reconcile(w.run);
    expect(out.status).toBe("draft");
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("fails the run when the download is refused for good, rather than spin on it", async () => {
    // Links switched off for the workspace: every read used to retry and log.
    w.media = { ...w.media!, id: FRESH_MEDIA };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValueOnce(
      new AppException("repurpose/source_unsupported", "off", HttpStatus.BAD_REQUEST),
    );
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      "repurpose/source_unavailable",
      "getting_video",
    );
  });

  it("keeps waiting when the restart hit a database error, which clears by itself", async () => {
    w.media = { ...w.media!, id: FRESH_MEDIA };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValueOnce(Object.assign(new Error("pool"), { code: "P2024" }));
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("fails a run whose source project was deleted, or is gone", async () => {
    for (const project of [
      { deletedAt: new Date(), createdBy: "01JCUSER000000000000000000", sourceLanguage: "en" },
      null,
    ]) {
      w = world({ project });
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).toHaveBeenCalledWith(
        expect.anything(),
        "repurpose/source_unavailable",
        "getting_video",
      );
      expect(h.runs.reacquire).not.toHaveBeenCalled();
    }
  });

  it("fails a run whose probe failed and left the media 'uploaded'", async () => {
    w.media = { ...w.media!, status: "uploaded", uploadedAt: new Date() };
    w.jobs = [
      acquireJob({ status: "succeeded" }),
      job("media.probe", `media.probe:${MEDIA}`, {
        status: "failed",
        error: { code: "media/probe_failed" },
      }),
    ];
    const h = harness(w);

    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/processing_failed",
      "getting_video",
    );
  });

  it("waits on a media row whose newest preparation is still running", async () => {
    // The probe failed once and was restarted; only the newest counts, and
    // only this media row's.
    w.media = { ...w.media!, status: "probing", uploadedAt: new Date() };
    w.jobs = [
      acquireJob({ status: "succeeded" }),
      job("media.probe", `media.probe:${MEDIA}`, { status: "failed" }),
      job("media.proxy", `media.proxy:${FRESH_MEDIA}`, { status: "failed" }),
      job("media.probe", `media.probe:${MEDIA}`, { status: "running" }),
    ];
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("fails a run whose media failed after the download: too long for the plan", async () => {
    w.media = {
      ...w.media!,
      status: "failed",
      failureReason: "media/too_long",
      uploadedAt: new Date(),
    };
    w.jobs = [acquireJob({ status: "succeeded" })];
    const h = harness(w);

    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/source_too_long",
      "getting_video",
    );
  });

  describe("ready media with no transcript", () => {
    beforeEach(() => {
      w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
      w.jobs = [acquireJob({ status: "succeeded" })];
    });

    it("starts the transcription through the same seam an upload uses", async () => {
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledWith(MEDIA);
      expect(h.runs.failRun).not.toHaveBeenCalled();
    });

    it("fails the run with no_credits when the start was refused for want of them", async () => {
      w.balanceTenths = 0;
      const h = harness(w);
      h.autoTranscribe.maybeEnqueue.mockResolvedValueOnce(undefined);

      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).toHaveBeenCalledWith(
        expect.anything(),
        "repurpose/no_credits",
        "finding_clips",
      );
    });

    it("keeps waiting when the start was refused for any other reason (a full lane)", async () => {
      const h = harness(w);
      h.autoTranscribe.maybeEnqueue.mockResolvedValueOnce(undefined);
      const out = await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).not.toHaveBeenCalled();
      expect(out.status).toBe("draft");
    });

    it.each([
      ["nobody to charge", { createdBy: null, sourceLanguage: "hi-Latn" }],
      ["no language", { createdBy: "01JCUSER000000000000000000", sourceLanguage: " " }],
      ["no language at all", { createdBy: "01JCUSER000000000000000000", sourceLanguage: null }],
    ])(
      "fails the transcription when the project has %s: waiting will not fix it",
      async (_, fields) => {
        // The trigger refuses these without a word, and the run either read
        // "no credits" (when the balance happened to be low) or waited for good.
        w.project = { deletedAt: null, ...fields };
        w.balanceTenths = 0;
        const h = harness(w);

        await h.reconciler.reconcile(w.run);
        expect(h.autoTranscribe.maybeEnqueue).not.toHaveBeenCalled();
        expect(h.runs.failRun).toHaveBeenCalledWith(
          expect.anything(),
          "repurpose/transcription_failed",
          "finding_clips",
        );
      },
    );

    it("backs off when the queue itself refused the transcription", async () => {
      // A refused add leaves a dead row, a credit reserve and its release.
      const h = harness(w);
      h.autoTranscribe.maybeEnqueue.mockImplementation(async () => {
        w.jobs.push(
          job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, {
            status: "failed",
            startedAt: null,
            finishedAt: new Date(),
            error: { code: ERROR_CODES.unavailable },
          }),
        );
        return undefined;
      });
      const now = Date.parse("2026-09-26T12:00:00Z");

      await h.reconciler.reconcileIfDue(w.run, {}, now);
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(1);
      expect(h.runs.failRun).not.toHaveBeenCalled();

      await h.reconciler.reconcileIfDue(w.run, {}, now + RECONCILE_INTERVAL_MS);
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(1);
      await h.reconciler.reconcileIfDue(w.run, {}, now + QUEUE_DOWN_BACKOFF_MS);
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(2);
    });

    it("counts a failed transcription that ended after the run was last written", async () => {
      clock += 1_000;
      w.jobs.push(
        job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, {
          status: "failed",
          finishedAt: new Date(clock + 500),
        }),
      );
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).toHaveBeenCalledWith(
        expect.anything(),
        "repurpose/transcription_failed",
        "finding_clips",
      );
    });

    it("ignores one that ended before the run was last written: a retry reopened it since", async () => {
      w.jobs.push(
        job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, {
          status: "failed",
          finishedAt: new Date("2026-09-26T09:30:00Z"),
        }),
      );
      w.run = runRow({ updatedAt: new Date("2026-09-26T09:45:00Z") });
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).not.toHaveBeenCalled();
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledWith(MEDIA);
    });

    it("does not start a second transcription while one runs", async () => {
      w.jobs.push(job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`));
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.autoTranscribe.maybeEnqueue).not.toHaveBeenCalled();
    });

    it("fails the run when the transcription failed", async () => {
      w.jobs.push(
        job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, {
          status: "failed",
          error: { code: "asr/provider_failed" },
        }),
      );
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).toHaveBeenCalledWith(
        expect.anything(),
        "repurpose/transcription_failed",
        "finding_clips",
      );
    });

    it("ignores a transcription of a different media row", async () => {
      w.jobs.push(
        job("ai.transcribe", `transcribe:${PROJECT}:other`, {
          status: "failed",
          params: { mediaId: "01JCOTHER00000000000000000" },
        }),
      );
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).not.toHaveBeenCalled();
      expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalled();
    });
  });

  describe("a transcript", () => {
    const HKEY = `ai.highlights:${RUN}:${TRANSCRIPT}:1:default`;
    beforeEach(() => {
      w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
      w.transcript = { id: TRANSCRIPT };
      w.jobs = [acquireJob({ status: "succeeded" })];
    });

    it("starts discovery when nothing is looking for moments", async () => {
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.startHighlightDiscovery).toHaveBeenCalledWith(
        expect.objectContaining({ id: RUN }),
        TRANSCRIPT,
      );
    });

    it("does nothing while discovery runs (the enqueue would only dedupe)", async () => {
      w.jobs.push(job("ai.highlights", HKEY, { status: "queued", startedAt: null }));
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.startHighlightDiscovery).not.toHaveBeenCalled();
      expect(h.runs.failRun).not.toHaveBeenCalled();
    });

    it("fails the run with highlights_failed when discovery failed", async () => {
      w.run = runRow({ status: "analyzing", currentStage: "finding_clips" });
      w.jobs.push(job("ai.highlights", HKEY, { status: "failed", error: { code: "x" } }));
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).toHaveBeenCalledWith(
        expect.anything(),
        "repurpose/highlights_failed",
        "finding_clips",
      );
    });

    it("only reads discovery of the newest transcript", async () => {
      w.jobs.push(
        job("ai.highlights", `ai.highlights:${RUN}:01JCOLDTRANSCR1PT000000000:1:default`, {
          status: "failed",
        }),
      );
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).not.toHaveBeenCalled();
      expect(h.runs.startHighlightDiscovery).toHaveBeenCalled();
    });

    it("moves a run whose moments are stored on to picking them", async () => {
      w.run = runRow({ status: "analyzing", currentStage: "finding_clips" });
      w.candidates = 4;
      w.jobs.push(job("ai.highlights", HKEY, { status: "succeeded" }));
      const h = harness(w);

      const out = await h.reconciler.reconcile(w.run);
      expect(out.status).toBe("candidates_ready");
      expect(h.runs.publishStage).toHaveBeenCalledTimes(1);
    });

    it("backs off when discovery was refused for now", async () => {
      const h = harness(w);
      h.runs.startHighlightDiscovery.mockResolvedValueOnce({ outcome: "deferred" });
      const now = Date.parse("2026-09-26T12:00:00Z");

      await h.reconciler.reconcileIfDue(w.run, {}, now);
      await h.reconciler.reconcileIfDue(w.run, {}, now + RECONCILE_INTERVAL_MS);
      expect(h.runs.startHighlightDiscovery).toHaveBeenCalledTimes(1);
      await h.reconciler.reconcileIfDue(w.run, {}, now + QUEUE_DOWN_BACKOFF_MS);
      expect(h.runs.startHighlightDiscovery).toHaveBeenCalledTimes(2);
    });

    it("looks again, rather than failing, when the failed discovery is one a retry reopened past", async () => {
      // The retry's own start was refused for now (a database blink): the old
      // failed job is still the newest, and used to fail the run again.
      w.jobs.push(
        job("ai.highlights", HKEY, {
          status: "failed",
          finishedAt: new Date("2026-09-26T09:30:00Z"),
        }),
      );
      w.run = runRow({ status: "analyzing", updatedAt: new Date("2026-09-26T09:45:00Z") });
      const h = harness(w);
      await h.reconciler.reconcile(w.run);
      expect(h.runs.failRun).not.toHaveBeenCalled();
      expect(h.runs.startHighlightDiscovery).toHaveBeenCalled();
    });
  });

  it("hands a run that is past discovery to its clips", async () => {
    w.run = runRow({ status: "materializing", currentStage: "styles_formats" });
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.clips.reconcileClips).toHaveBeenCalledWith(RUN);
    expect(h.findJobs).not.toHaveBeenCalled();
  });
});

describe("RepurposeReconciler — a job that stopped making progress", () => {
  const since = (minutesAgo: number) => ({
    queuedAt: new Date(NOW - minutesAgo * MINUTE - 1_000),
    startedAt: new Date(NOW - minutesAgo * MINUTE),
  });

  it("fails the run, then cancels the lost job to give back its lane slot and credit hold", async () => {
    // Production runs no scheduler: this used to read "Creating the transcript"
    // for good, holding one of a Free workspace's two lane slots.
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    w.jobs = [
      acquireJob({ status: "succeeded" }),
      job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, since(90)),
    ];
    const h = harness(w);

    const out = await h.reconciler.reconcile(w.run);
    // Failed first, so the cancel's failure handler finds a run already answered.
    expect(h.calls).toEqual(["fail:repurpose/stage_timeout", "cancel:ai.transcribe:failed"]);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/stage_timeout",
      "finding_clips",
    );
    expect(out.status).toBe("failed");
    expect(w.jobs[1]?.status).toBe("cancelled");
    expect(h.autoTranscribe.maybeEnqueue).not.toHaveBeenCalled();
  });

  it("fails a download the acquisition worker never picked up", async () => {
    w.jobs = [
      acquireJob({ status: "queued", startedAt: null, queuedAt: new Date(NOW - 45 * MINUTE) }),
    ];
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/stage_timeout",
      "getting_video",
    );
    expect(h.runs.cancelJobs).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), [
      w.jobs[0]?.id,
    ]);
  });

  it("fails an upload whose probe sat queued, but leaves the probe queued for when worker-media is back", async () => {
    // Cancelling it removed the BullMQ job and left the media `uploaded` for
    // good: nothing re-probes an uploaded file, so a worker-media outage past
    // the queue wait made every upload in it unusable.
    w = world({
      run: runRow({ sourceKind: "upload", sourceFingerprint: null }),
      jobs: [
        job("media.probe", `media.probe:${MEDIA}`, {
          status: "queued",
          startedAt: null,
          queuedAt: new Date(NOW - 45 * MINUTE),
        }),
      ],
    });
    w.media = { ...w.media!, status: "uploaded", uploadedAt: new Date(NOW - 46 * MINUTE) };
    const h = harness(w);

    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/stage_timeout",
      "getting_video",
    );
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
    expect(w.jobs[0]?.status).toBe("queued");

    // The worker comes back, the probe and proxy run, and Try again works.
    w.jobs[0] = { ...w.jobs[0]!, status: "succeeded", finishedAt: new Date(NOW) };
    w.media = { ...w.media, status: "ready", durationMs: 600_000 };
    await expect(h.reconciler.retryPossible(w.run, "repurpose/stage_timeout")).resolves.toBe(true);
    const out = await h.reconciler.redrive(w.run);
    expect(out.status).toBe("draft");
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(1);
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
  });

  it("cancels nothing when the run had moved on before it could be failed", async () => {
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    w.jobs = [
      acquireJob({ status: "succeeded" }),
      job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, since(90)),
    ];
    const h = harness(w);
    h.runs.failRun.mockResolvedValueOnce(null);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
  });

  it("leaves a job that is slow but inside its ceiling running", async () => {
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    w.jobs = [
      acquireJob({ status: "succeeded" }),
      job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, since(70)),
    ];
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).not.toHaveBeenCalled();
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
  });
});

describe("RepurposeReconciler — an upload that never arrived", () => {
  it("fails the run with upload_missing a day after it was created with no file", async () => {
    w = world({
      run: runRow({
        sourceKind: "upload",
        sourceFingerprint: null,
        createdAt: new Date(NOW - UPLOAD_WINDOW_MS - MINUTE),
      }),
      media: null,
      jobs: [],
    });
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/upload_missing",
      "getting_video",
    );
  });

  it("measures a stuck upload from its ticket, not from when the run was made", async () => {
    w = world({
      run: runRow({
        sourceKind: "upload",
        sourceFingerprint: null,
        createdAt: new Date(NOW - 2 * UPLOAD_WINDOW_MS),
      }),
      jobs: [],
    });
    w.media = { ...w.media!, status: "uploading", createdAt: new Date(NOW - 60 * MINUTE) };
    const h = harness(w);
    await h.reconciler.reconcile(w.run);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });
});

describe("RepurposeReconciler.redrive — Try again", () => {
  it("looks for moments again, with the run already reading 'analyzing' when the job is queued", async () => {
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/highlights_failed",
        currentStage: "finding_clips",
      }),
      transcript: { id: TRANSCRIPT },
    });
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    const h = harness(w);

    const out = await h.reconciler.redrive(w.run);
    // A fast completion is only accepted by a run still waiting for one.
    expect(h.calls).toEqual(["discover:analyzing"]);
    expect(out).toMatchObject({ status: "analyzing", failureCode: null });
  });

  it("fetches a failed link again into a fresh row, with the address the first fetch carried", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      jobs: [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })],
    });
    w.media = { ...w.media!, status: "failed", failureReason: "media/source_blocked" };
    const h = harness(w);

    const out = await h.reconciler.redrive(w.run);
    expect(h.runs.reacquire).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      URL,
      undefined,
    );
    expect(h.calls).toEqual(["reacquire:draft"]);
    expect(out).toMatchObject({ status: "draft", failureCode: null });
  });

  it("leaves a retried download that the lane refused for the reconciler to start", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      jobs: [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })],
    });
    w.media = { ...w.media!, status: "failed", failureReason: "media/source_blocked" };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValueOnce(
      new AppException("jobs/concurrency_cap", "busy", HttpStatus.TOO_MANY_REQUESTS),
    );

    const out = await h.reconciler.redrive(w.run);
    expect(out.status).toBe("draft");
  });

  it("puts the failure back, exactly as it was, when the download cannot be restarted at all", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked", progress: 20 }),
      jobs: [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })],
    });
    w.media = { ...w.media!, status: "failed", failureReason: "media/source_blocked" };
    const h = harness(w);
    h.runs.reacquire.mockRejectedValueOnce(
      new AppException("repurpose/source_unsupported", "off", HttpStatus.BAD_REQUEST),
    );

    await expect(h.reconciler.redrive(w.run)).rejects.toThrow("off");
    // Progress too: the reopen reset it to the draft's, and the rail read 0%.
    expect(w.run).toMatchObject({
      status: "failed",
      failureCode: "repurpose/source_blocked",
      progress: 20,
    });
  });

  it("answers the same 409 create does when the link was started again after retry checked", async () => {
    // `repurpose_runs_live_source_idx` refuses the reopen; it used to be a raw 500.
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      jobs: [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })],
    });
    w.media = { ...w.media!, status: "failed", failureReason: "media/source_blocked" };
    const h = harness(w);
    h.updateRun.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    h.runs.duplicateOf.mockResolvedValueOnce(
      new AppException("repurpose/source_already_running", "running", HttpStatus.CONFLICT, {
        existingRunId: "01JCRN0000000000000000000B",
      }),
    );

    const refused = (await h.reconciler
      .redrive(w.run)
      .catch((error: unknown) => error)) as AppException;
    expect(refused.code).toBe("repurpose/source_already_running");
    expect(refused.details).toEqual({ existingRunId: "01JCRN0000000000000000000B" });
    expect(h.runs.duplicateOf).toHaveBeenCalledWith(WS, "youtube:dQw4w9WgXcQ", RUN);
    expect(h.runs.reacquire).not.toHaveBeenCalled();
  });

  it("restarts the transcription, and leaves the run open when the lane is full, not failed again", async () => {
    // The old failed job ended before the retry, so it is answered for: a
    // later read starts the transcription once the lane frees, instead of
    // failing the run again for the old reason (which is why this used to 503).
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/transcription_failed",
        updatedAt: new Date("2026-09-26T09:40:00Z"),
      }),
      jobs: [
        acquireJob({ status: "succeeded" }),
        job("ai.transcribe", `transcribe:${PROJECT}:${MEDIA}`, {
          status: "failed",
          finishedAt: new Date("2026-09-26T09:30:00Z"),
        }),
      ],
    });
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    const h = harness(w);
    h.autoTranscribe.maybeEnqueue.mockResolvedValueOnce(undefined);

    await expect(h.reconciler.redrive(w.run)).resolves.toMatchObject({
      status: "draft",
      failureCode: null,
    });
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledWith(MEDIA);

    const later = await h.reconciler.reconcile(w.run);
    expect(later.status).toBe("draft");
    expect(h.runs.failRun).not.toHaveBeenCalled();
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(2);
  });

  it("fails the retried transcription with no_credits when the balance cannot cover it", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/no_credits" }),
      jobs: [acquireJob({ status: "succeeded" })],
      balanceTenths: 0,
    });
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    const h = harness(w);
    h.autoTranscribe.maybeEnqueue.mockResolvedValueOnce(undefined);

    const out = await h.reconciler.redrive(w.run);
    expect(out).toMatchObject({ status: "failed", failureCode: "repurpose/no_credits" });
  });

  it("goes back to a run's clips rather than starting again", async () => {
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/clip_failed",
        currentStage: "styles_formats",
      }),
      transcript: { id: TRANSCRIPT },
      candidates: 3,
      readyClips: 1,
    });
    const h = harness(w);

    const out = await h.reconciler.redrive(w.run);
    expect(out.status).toBe("review_ready");
    expect(h.clips.reconcileClips).toHaveBeenCalledWith(RUN);
    expect(h.runs.startHighlightDiscovery).not.toHaveBeenCalled();
  });

  it("goes back to watching a download that is still running", async () => {
    w = world({ run: runRow({ status: "failed", failureCode: "repurpose/stage_timeout" }) });
    const h = harness(w);
    const out = await h.reconciler.redrive(w.run);
    expect(out.status).toBe("draft");
    expect(h.runs.reacquire).not.toHaveBeenCalled();
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
  });

  it("cancels a lost discovery before it looks again, so the new job is not deduped onto it", async () => {
    const HKEY = `ai.highlights:${RUN}:${TRANSCRIPT}:1:default`;
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/stage_timeout",
        currentStage: "finding_clips",
      }),
      transcript: { id: TRANSCRIPT },
      jobs: [
        acquireJob({ status: "succeeded" }),
        job("ai.highlights", HKEY, {
          queuedAt: new Date(NOW - 90 * MINUTE),
          startedAt: new Date(NOW - 90 * MINUTE),
        }),
      ],
    });
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    const h = harness(w);

    const out = await h.reconciler.redrive(w.run);
    expect(h.calls).toEqual(["cancel:ai.highlights:failed", "discover:analyzing"]);
    expect(out.status).toBe("analyzing");
  });

  it("fetches a lost download again into a fresh row, reading the plan again after the cancel", async () => {
    // Before the cancel the plan was "fetch into the pending row"; the cancel's
    // failure handler failed that row, so the fetch must reserve a fresh one.
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/stage_timeout" }),
      jobs: [
        acquireJob({
          queuedAt: new Date(NOW - 60 * MINUTE),
          startedAt: new Date(NOW - 60 * MINUTE),
        }),
      ],
    });
    const h = harness(w);

    const out = await h.reconciler.redrive(w.run);
    expect(h.calls).toEqual(["cancel:media.acquire:failed", "reacquire:draft"]);
    expect(h.runs.reacquire).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      URL,
      undefined,
    );
    expect(out.status).toBe("draft");
  });

  it("cancels nothing when the retry is refused", async () => {
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/stage_timeout",
        sourceKind: "upload",
        sourceFingerprint: null,
      }),
      jobs: [
        job("media.probe", `media.probe:${MEDIA}`, {
          queuedAt: new Date(NOW - 90 * MINUTE),
          startedAt: new Date(NOW - 90 * MINUTE),
        }),
      ],
    });
    w.media = { ...w.media!, status: "probing", uploadedAt: new Date() };
    const h = harness(w);

    await expect(h.reconciler.redrive(w.run)).rejects.toMatchObject({
      code: "repurpose/not_retryable",
    });
    expect(h.runs.cancelJobs).not.toHaveBeenCalled();
  });

  it("answers 409 when there is no stage a retry could restart", async () => {
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/processing_failed",
        sourceKind: "upload",
      }),
      jobs: [],
    });
    w.media = {
      ...w.media!,
      status: "failed",
      failureReason: "media/corrupt",
      uploadedAt: new Date(),
    };
    const h = harness(w);

    const refused = await h.reconciler.redrive(w.run).catch((error: unknown) => error);
    expect((refused as AppException).httpStatus).toBe(HttpStatus.CONFLICT);
    expect((refused as AppException).code).toBe("repurpose/not_retryable");
    expect(w.run.status).toBe("failed");
  });
});

describe("RepurposeReconciler.retryPossible — the page offers only a retry that would run", () => {
  it("says no for an upload whose file could not be read", async () => {
    // "Try again" was the card's main button, and every press answered 409.
    w = world({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/processing_failed",
        sourceKind: "upload",
        sourceFingerprint: null,
      }),
      jobs: [],
    });
    w.media = {
      ...w.media!,
      status: "failed",
      failureReason: "media/corrupt",
      uploadedAt: new Date(),
    };
    const h = harness(w);
    await expect(h.reconciler.retryPossible(w.run, "repurpose/processing_failed")).resolves.toBe(
      false,
    );
  });

  it("says no for a run whose source project was deleted", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_unavailable" }),
      project: null,
    });
    const h = harness(w);
    await expect(h.reconciler.retryPossible(w.run, "repurpose/source_unavailable")).resolves.toBe(
      false,
    );
  });

  it("says no for a transcript with no timings, whose copy points at starting again", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/transcript_untimed" }),
      transcript: { id: TRANSCRIPT },
    });
    const h = harness(w);
    await expect(h.reconciler.retryPossible(w.run, "repurpose/transcript_untimed")).resolves.toBe(
      false,
    );
  });

  it("says yes for a link that can be fetched again", async () => {
    w = world({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      jobs: [acquireJob({ status: "failed", error: { code: "media/source_blocked" } })],
    });
    w.media = { ...w.media!, status: "failed", failureReason: "media/source_blocked" };
    const h = harness(w);
    await expect(h.reconciler.retryPossible(w.run, "repurpose/source_blocked")).resolves.toBe(true);
  });
});

describe("RepurposeReconciler — the watchdog", () => {
  beforeEach(() => {
    w.media = { ...w.media!, status: "ready", uploadedAt: new Date(), durationMs: 600_000 };
    w.jobs = [acquireJob({ status: "succeeded" })];
  });

  it("starts a transcription the lane refused once it frees, with nobody reading the run", async () => {
    // Nothing else wakes it: the completion that frees the lane swallows the
    // refusal, and the page promised "we'll keep working" after it was closed.
    const h = harness(w);
    h.autoTranscribe.maybeEnqueue.mockResolvedValueOnce(undefined);

    await h.reconciler.sweepOnce(NOW);
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(1);
    await h.reconciler.sweepOnce(NOW + DEFAULT_RECONCILE_WATCHDOG_MS);
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(2);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("lists only runs that have not settled", async () => {
    const h = harness(w);
    await h.reconciler.sweepOnce(NOW);
    const listing = vi.mocked(h.prisma.repurposeRun.findMany).mock.calls[0]?.[0] as {
      where: { status: { notIn: string[] } };
    };
    expect(listing.where.status.notIn).toEqual(
      expect.arrayContaining(["failed", "cancelled", "published", "partially_published"]),
    );
  });

  it("leaves a workspace whose repurposing is switched off alone", async () => {
    // The kill switch has to stop background work too: it spends credits.
    const h = harness(w);
    h.runs.flagEnabled.mockResolvedValue(false);
    await h.reconciler.sweepOnce(NOW);
    expect(h.findJobs).not.toHaveBeenCalled();
    expect(h.autoTranscribe.maybeEnqueue).not.toHaveBeenCalled();
  });

  it("skips a workspace whose flags cannot be read, and never throws", async () => {
    const h = harness(w);
    h.runs.flagEnabled.mockRejectedValueOnce(new Error("redis went away"));
    await expect(h.reconciler.sweepOnce(NOW)).resolves.toBeUndefined();
    expect(h.findJobs).not.toHaveBeenCalled();
  });

  it("never throws when the listing fails; the next pass tries again", async () => {
    const h = harness(w);
    vi.mocked(h.prisma.repurposeRun.findMany).mockRejectedValueOnce(new Error("pool"));
    await expect(h.reconciler.sweepOnce(NOW)).resolves.toBeUndefined();
    await h.reconciler.sweepOnce(NOW);
    expect(h.autoTranscribe.maybeEnqueue).toHaveBeenCalledTimes(1);
  });

  it("never runs two passes at once", async () => {
    const h = harness(w);
    await Promise.all([h.reconciler.sweepOnce(NOW), h.reconciler.sweepOnce(NOW)]);
    expect(h.prisma.repurposeRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("runs on its own timer from boot, independent of the scheduler, and stops at shutdown", async () => {
    vi.stubEnv("REPURPOSE_RECONCILE_INTERVAL_MS", "30000");
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "1");
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
    const h = harness(w);

    h.reconciler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.prisma.repurposeRun.findMany).toHaveBeenCalledTimes(1);

    await h.reconciler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.prisma.repurposeRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("stops a pass at the next run once shutdown begins, and starts no new one", async () => {
    // A pass can cover up to 200 runs, one after another, while Nest tears
    // down the Prisma client they read through.
    const h = harness(w);
    const second = { ...w.run, id: "01JCRN0000000000000000000B", workspaceId: "01JCWS0B" };
    vi.mocked(h.prisma.repurposeRun.findMany).mockResolvedValueOnce([{ ...w.run }, second]);
    let release: (on: boolean) => void = () => undefined;
    h.runs.flagEnabled.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    const reconciled = vi.spyOn(h.reconciler, "reconcileIfDue");

    const pass = h.reconciler.sweepOnce(NOW);
    await vi.waitFor(() => expect(h.runs.flagEnabled).toHaveBeenCalledTimes(1));
    const shutdown = h.reconciler.onModuleDestroy();
    release(true);
    await shutdown;
    await pass;

    // The run it was on finishes; the one after it is left for the next boot.
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect(reconciled).toHaveBeenCalledWith(expect.objectContaining({ id: RUN }), {}, NOW);
    expect(h.runs.flagEnabled).toHaveBeenCalledTimes(1);

    await h.reconciler.sweepOnce(NOW);
    expect(h.prisma.repurposeRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("stays off when REPURPOSE_RECONCILE_INTERVAL_MS is 0 (tests, one-shot processes)", async () => {
    vi.stubEnv("REPURPOSE_RECONCILE_INTERVAL_MS", "0");
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
    const h = harness(w);

    h.reconciler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.prisma.repurposeRun.findMany).not.toHaveBeenCalled();
    await h.reconciler.onModuleDestroy();
  });
});

describe("reconcileWatchdogIntervalMs", () => {
  it("is on by default, every thirty seconds", () => {
    expect(reconcileWatchdogIntervalMs({})).toBe(DEFAULT_RECONCILE_WATCHDOG_MS);
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: " " })).toBe(
      DEFAULT_RECONCILE_WATCHDOG_MS,
    );
  });

  it("is off at 0", () => {
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: "0" })).toBe(0);
  });

  it("takes a whole number of milliseconds, and falls back on what it cannot read", () => {
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: "45000" })).toBe(45_000);
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: "soon" })).toBe(
      DEFAULT_RECONCILE_WATCHDOG_MS,
    );
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: "-5" })).toBe(
      DEFAULT_RECONCILE_WATCHDOG_MS,
    );
  });

  it("never runs more often than once a second", () => {
    expect(reconcileWatchdogIntervalMs({ REPURPOSE_RECONCILE_INTERVAL_MS: "10" })).toBe(1_000);
  });
});

describe("youtubeUrlOf", () => {
  it("rebuilds the canonical watch URL from a YouTube fingerprint", () => {
    expect(youtubeUrlOf("youtube_url", "youtube:5eW6Eagr9XA")).toBe(
      "https://www.youtube.com/watch?v=5eW6Eagr9XA",
    );
  });

  it("rebuilds nothing for another kind, a missing or a malformed fingerprint", () => {
    expect(youtubeUrlOf("direct_media_url", "youtube:5eW6Eagr9XA")).toBeNull();
    expect(youtubeUrlOf("youtube_url", null)).toBeNull();
    expect(youtubeUrlOf("youtube_url", "youtube:short")).toBeNull();
    expect(youtubeUrlOf("youtube_url", "youtube:5eW6Eagr9XA&list=x")).toBeNull();
  });
});
