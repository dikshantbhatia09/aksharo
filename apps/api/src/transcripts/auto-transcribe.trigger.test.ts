import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutoTranscribeTrigger } from "./auto-transcribe.trigger.js";

import type { TranscriptDocumentService } from "./transcript-document.service.js";
import type { TranscriptsService } from "./transcripts.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobsService } from "../jobs/jobs.service.js";

const AUDIO_KEY = "ws/01WORKSPACE/p/01PROJECT/media/01MEDIA/audio16k.wav";

const READY_PRIMARY: {
  id: string;
  projectId: string;
  role: string;
  status: string;
  durationMs: number | null;
  audio16kKey: string | null;
  hasAudio: boolean | null;
} = {
  id: "01MEDIA",
  projectId: "01PROJECT",
  role: "primary",
  status: "ready",
  durationMs: 20_200,
  audio16kKey: AUDIO_KEY,
  hasAudio: true,
};

/**
 * W5: probed, still being prepared, and the proxy has written its ASR audio
 * back ahead of the 540p encode.
 */
const AUDIO_READY_EARLY = { status: "probing", audio16kKey: AUDIO_KEY, hasAudio: true } as const;

/** A row of the `jobs` table, as far as the trigger reads it. */
interface JobRow {
  id: string;
  type: string;
  projectId: string;
  jobKey: string;
  status: string;
  startedAt: Date | null;
}

const FIRST_KEY = "transcribe:01PROJECT:01MEDIA";

/** Some other job of the workspace holding a plan-lane slot (a proxy mid-encode). */
function laneJob(type: string, n: number): JobRow {
  return {
    id: `01LANE${String(n)}`,
    type,
    projectId: "01OTHER",
    jobKey: `${type}:${String(n)}`,
    status: "running",
    startedAt: new Date("2026-09-27T07:00:00Z"),
  };
}

const FRESH_PROJECT: {
  id: string;
  workspaceId: string;
  createdBy: string | null;
  sourceLanguage: string | null;
  edgDocument: { id: string } | null;
} = {
  id: "01PROJECT",
  workspaceId: "01WORKSPACE",
  createdBy: "01USER",
  sourceLanguage: "hi-Latn",
  edgDocument: null,
};

/** A column filter the way the trigger writes them: equals, `in` or `notIn`. */
function matches(value: string, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  const { in: within, notIn } = filter as { in?: readonly string[]; notIn?: readonly string[] };
  if (within !== undefined && !within.includes(value)) return false;
  if (notIn !== undefined && notIn.includes(value)) return false;
  return true;
}

interface JobWhere {
  workspaceId?: string;
  projectId?: string;
  type?: unknown;
  jobKey?: string;
  status?: unknown;
}

function harness(
  overrides: {
    media?: Partial<typeof READY_PRIMARY> | null;
    /** What the media reads as when looked at again after a start (`stopIfMediaFailed`). */
    mediaAfterStart?: Partial<typeof READY_PRIMARY>;
    project?: Partial<typeof FRESH_PROJECT> | null;
    transcriptCount?: number;
    /** A clips run on this project that is over: the person stopped it, or it failed. */
    settledRun?: "cancelled" | "failed";
    transcribe?: () => Promise<{ jobId: string; deduplicated?: boolean }>;
    ensure?: () => Promise<{ status: string; edgId?: string }>;
    /** Rows of the workspace's `jobs` table, in `queuedAt` order, newest first. */
    jobs?: readonly Partial<JobRow>[];
    /** The workspace's plan (a live subscription); Free without one. */
    plan?: "free" | "starter" | "creator" | "studio" | "agency";
  } = {},
) {
  const media = overrides.media === null ? null : { ...READY_PRIMARY, ...overrides.media };
  const project = overrides.project === null ? null : { ...FRESH_PROJECT, ...overrides.project };
  const jobs: JobRow[] = (overrides.jobs ?? []).map((row, n) => ({
    id: `01JOB${String(n)}`,
    type: "ai.transcribe",
    projectId: "01PROJECT",
    jobKey: FIRST_KEY,
    status: "queued",
    startedAt: null,
    ...row,
  }));
  const select = (where: JobWhere) =>
    jobs.filter(
      (row) =>
        (where.projectId === undefined || row.projectId === where.projectId) &&
        matches(row.type, where.type) &&
        (where.jobKey === undefined || row.jobKey === where.jobKey) &&
        matches(row.status, where.status),
    );
  const transcribe = vi.fn(overrides.transcribe ?? (async () => ({ jobId: "01JOB" })));
  const findMedia = vi.fn(async () => media);
  if (overrides.mediaAfterStart !== undefined && media !== null) {
    findMedia
      .mockResolvedValueOnce(media)
      .mockResolvedValueOnce({ ...media, ...overrides.mediaAfterStart });
  }
  const findRun = vi.fn(async (args: { where: { status: { in: readonly string[] } } }) =>
    overrides.settledRun !== undefined && args.where.status.in.includes(overrides.settledRun)
      ? { id: "01RUN" }
      : null,
  );
  const prisma = {
    mediaAsset: { findUnique: findMedia },
    project: { findFirst: vi.fn(async () => project) },
    transcript: { count: vi.fn(async () => overrides.transcriptCount ?? 0) },
    repurposeRun: { findFirst: findRun },
    job: {
      findMany: vi.fn(async (args: { where: JobWhere }) => select(args.where)),
      findFirst: vi.fn(async (args: { where: JobWhere }) => select(args.where)[0] ?? null),
      count: vi.fn(async (args: { where: JobWhere }) => select(args.where).length),
    },
    subscription: {
      findFirst: vi.fn(async () =>
        overrides.plan === undefined ? null : { plan: { key: overrides.plan } },
      ),
    },
  } as unknown as PrismaService;
  const ensure = vi.fn(overrides.ensure ?? (async () => ({ status: "created", edgId: "01EDG" })));
  const cancel = vi.fn(async () => ({}));
  const trigger = new AutoTranscribeTrigger(
    prisma,
    { transcribe } as unknown as TranscriptsService,
    { ensure } as unknown as TranscriptDocumentService,
    { cancel } as unknown as JobsService,
  );
  return { trigger, transcribe, ensure, cancel };
}

describe("AutoTranscribeTrigger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // The defect this exists to prevent: the browser fires `transcribe` before the
  // probe has run, gets a 409, swallows it, and nothing ever retries — so the
  // project opens with no editing document.
  it("starts the first transcription once the primary media is ready", async () => {
    const { trigger, transcribe } = harness();
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
    expect(transcribe).toHaveBeenCalledWith({
      projectId: "01PROJECT",
      workspaceId: "01WORKSPACE",
      userId: "01USER",
      languages: ["hi-Latn"],
    });
  });

  it("spends nothing on a clips run the person cancelled after its download", async () => {
    const { trigger, transcribe } = harness({ settledRun: "cancelled" });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("starts nothing automatic for a clips run that already failed: Try again is the way back", async () => {
    // Its Try again reopens the run before it asks, so the run is not failed
    // by then; an automatic ask meanwhile would charge behind "it failed".
    const { trigger, transcribe } = harness({ settledRun: "failed" });
    await expect(
      trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true }),
    ).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("leaves a project that already has an editing document alone", async () => {
    // Replace-media (B15 §5) and re-transcription own their own paths.
    const { trigger, transcribe } = harness({ project: { edgDocument: { id: "01EDG" } } });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("does not charge twice when a transcript already exists", async () => {
    const { trigger, transcribe } = harness({ transcriptCount: 1 });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  // A repurposed clip: its transcript slice was cloned before its video was
  // probed, and nothing else ever turned it into an editing document.
  it("builds the document from a transcript the project already has", async () => {
    const { trigger, transcribe, ensure } = harness({ transcriptCount: 1 });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalledWith("01PROJECT");
    expect(transcribe).not.toHaveBeenCalled();
  });

  // W5: the transcription can now finish as the proxy does, so the proxy's ask
  // can land between the producer storing the transcript and building the
  // document from it (`TranscribeCompletionHandler`), which the job stays
  // `running` through.
  it("leaves the document to a producer that is still writing the transcript", async () => {
    const { trigger, transcribe, ensure } = harness({
      transcriptCount: 1,
      jobs: [{ status: "running", startedAt: new Date("2026-09-27T07:00:00Z") }],
    });
    await expect(
      trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true }),
    ).resolves.toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("leaves it to an alignment still writing an imported transcript, too", async () => {
    const { trigger, ensure } = harness({
      transcriptCount: 1,
      jobs: [{ type: "ai.align", jobKey: "align:01PROJECT", status: "queued" }],
    });
    await trigger.maybeEnqueue("01MEDIA");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("builds it once that producer has finished", async () => {
    const { trigger, ensure } = harness({
      transcriptCount: 1,
      jobs: [{ status: "succeeded", startedAt: new Date("2026-09-27T07:00:00Z") }],
    });
    await trigger.maybeEnqueue("01MEDIA");
    expect(ensure).toHaveBeenCalledWith("01PROJECT");
  });

  it("never fails the proxy job when the document cannot be built", async () => {
    const { trigger, ensure } = harness({
      transcriptCount: 1,
      ensure: async () => {
        throw new Error("segmenter exploded");
      },
    });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalled();
  });

  it("does not build a document for a project that has neither transcript nor document", async () => {
    const { trigger, ensure } = harness();
    await trigger.maybeEnqueue("01MEDIA");
    expect(ensure).not.toHaveBeenCalled();
  });

  it.each([
    ["a secondary asset", { role: "broll" }],
    [
      "media still processing, its audio not written back yet",
      { status: "probing", audio16kKey: null },
    ],
    ["media with no measured duration", { durationMs: null }],
    // Bytes that landed but are not probed yet: a clip re-cut lands new bytes
    // on the same row without clearing the old keys, so an audio key next to
    // `uploaded` can be the previous file's.
    ["an unprobed upload carrying an old audio key", { status: "uploaded" }],
    ["audio on media the probe never measured", { ...AUDIO_READY_EARLY, hasAudio: null }],
    ["audio on media still pending", { status: "pending" }],
  ])("ignores %s", async (_label, media) => {
    const { trigger, transcribe } = harness({ media });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ["no source language was chosen", { sourceLanguage: null }],
    ["there is no creator to attribute the credit hold to", { createdBy: null }],
  ])("does not guess when %s", async (_label, project) => {
    const { trigger, transcribe } = harness({ project });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  // The proxy genuinely succeeded; failing its completion would retry the proxy,
  // not the transcription.
  it("never lets a failed start fail the proxy job", async () => {
    const { trigger } = harness({
      transcribe: async () => {
        throw new Error("credits/insufficient");
      },
    });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
  });

  it("does nothing when the media or project has been deleted", async () => {
    const gone = harness({ media: null });
    await expect(gone.trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
    const orphan = harness({ project: null });
    await expect(orphan.trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
  });

  // --- W5: start on the audio, ahead of the video encode ----------------------

  describe("on audio written back ahead of the encode (W5)", () => {
    /** The encode this ask overlaps, holding a lane slot of its own. */
    const encoding = laneJob("media.proxy", 1);

    it("starts the first transcription without waiting for the proxy to finish", async () => {
      const { trigger, transcribe } = harness({
        media: AUDIO_READY_EARLY,
        plan: "studio",
        jobs: [encoding],
      });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
      expect(transcribe).toHaveBeenCalledWith({
        projectId: "01PROJECT",
        workspaceId: "01WORKSPACE",
        userId: "01USER",
        languages: ["hi-Latn"],
      });
    });

    it("answers the second ask (the media now ready) with the first ask's live job", async () => {
      // Asked when the audio lands, then again when the proxy completes: the
      // open job under the key is the answer, and nothing is enqueued again.
      const { trigger, transcribe } = harness({
        jobs: [{ id: "01EARLY", status: "running", startedAt: new Date("2026-09-27T07:00:00Z") }],
      });
      await expect(trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true })).resolves.toEqual({
        jobId: "01EARLY",
      });
      expect(transcribe).not.toHaveBeenCalled();
    });

    it("builds a clip's document from its cloned transcript once the probe has measured it", async () => {
      // Section 13's invariant (a project with a transcript has an editing
      // document) holds as early: the probe wrote the dimensions before it
      // enqueued the proxy that wrote this audio.
      const { trigger, transcribe, ensure } = harness({
        media: AUDIO_READY_EARLY,
        transcriptCount: 1,
      });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
      expect(ensure).toHaveBeenCalledWith("01PROJECT");
      expect(transcribe).not.toHaveBeenCalled();
    });

    it("spends nothing on a clips run the person stopped, early as late", async () => {
      const { trigger, transcribe } = harness({
        media: AUDIO_READY_EARLY,
        plan: "studio",
        settledRun: "cancelled",
      });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
      expect(transcribe).not.toHaveBeenCalled();
    });

    describe("the plan lane", () => {
      // Free has two slots and the encode holds one: an early start would fill
      // the lane, and a second upload's probe would be refused (and that upload
      // fail) until the encode ends. It waits for the `ready` ask instead.
      it("leaves Free's last slot free, and starts at `ready` instead", async () => {
        const early = harness({ media: AUDIO_READY_EARLY, jobs: [encoding] });
        await expect(early.trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
        expect(early.transcribe).not.toHaveBeenCalled();

        const ready = harness({ jobs: [encoding] });
        await expect(
          ready.trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true }),
        ).resolves.toEqual({ jobId: "01JOB" });
      });

      it("starts early when a slot is left over after it", async () => {
        // Starter: four slots, the encode and one other job in flight.
        const { trigger, transcribe } = harness({
          media: AUDIO_READY_EARLY,
          plan: "starter",
          jobs: [encoding, laneJob("ai.highlights", 2)],
        });
        await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
        expect(transcribe).toHaveBeenCalledTimes(1);
      });

      it("waits when it would take the last one", async () => {
        const { trigger, transcribe } = harness({
          media: AUDIO_READY_EARLY,
          plan: "starter",
          jobs: [encoding, laneJob("ai.highlights", 2), laneJob("media.probe", 3)],
        });
        await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
        expect(transcribe).not.toHaveBeenCalled();
      });

      it("does not count background work, as admission does not", async () => {
        const { trigger, transcribe } = harness({
          media: AUDIO_READY_EARLY,
          jobs: [laneJob("ai.faces", 2), laneJob("ai.faces", 3)],
        });
        await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
        expect(transcribe).toHaveBeenCalledTimes(1);
      });

      it("still answers a repeated early ask with the open job, whatever the lane", async () => {
        const { trigger, transcribe } = harness({
          media: AUDIO_READY_EARLY,
          jobs: [
            encoding,
            { id: "01EARLY", status: "running", startedAt: new Date("2026-09-27T07:00:00Z") },
          ],
        });
        await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01EARLY" });
        expect(transcribe).not.toHaveBeenCalled();
      });
    });

    // The proxy's failure handler marks the media failed and then stops the
    // transcriptions it can see. A start that read `probing` just before can
    // write its job just after that look; this start looks again, and stops it.
    it("stops the job it just started when the media failed meanwhile", async () => {
      const { trigger, cancel } = harness({
        media: AUDIO_READY_EARLY,
        mediaAfterStart: { status: "failed" },
        plan: "studio",
      });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledWith("01JOB", "01WORKSPACE");
    });

    it("keeps the job when the media is still fine", async () => {
      const { trigger, cancel } = harness({
        media: AUDIO_READY_EARLY,
        mediaAfterStart: { status: "ready" },
        plan: "studio",
      });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe("firstAttemptOnly — the media pipeline's own asks", () => {
    const at = new Date("2026-09-27T07:00:00Z");

    it("does not start a second transcription after the early one ran and failed", async () => {
      const { trigger, transcribe } = harness({ jobs: [{ status: "failed", startedAt: at }] });
      await expect(
        trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true }),
      ).resolves.toBeUndefined();
      expect(transcribe).not.toHaveBeenCalled();
    });

    it.each([
      ["refused by the queue", "failed"],
      ["timed out waiting for a worker (the queue-wait sweep or the lease reaper)", "failed"],
      // The proxy's failure handler stopping it before it began: its media is
      // back only because a replayed proxy brought it back.
      ["cancelled before a worker began it", "cancelled"],
    ])("still starts one when the only earlier row was %s", async (_label, status) => {
      const { trigger, transcribe } = harness({ jobs: [{ status, startedAt: null }] });
      await expect(trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true })).resolves.toEqual({
        jobId: "01JOB",
      });
      expect(transcribe).toHaveBeenCalledTimes(1);
    });

    it("still starts one when the earlier one was stopped mid-run with its failed media", async () => {
      const { trigger, transcribe } = harness({ jobs: [{ status: "cancelled", startedAt: at }] });
      await expect(trigger.maybeEnqueue("01MEDIA", { firstAttemptOnly: true })).resolves.toEqual({
        jobId: "01JOB",
      });
      expect(transcribe).toHaveBeenCalledTimes(1);
    });

    it("leaves a restart to whoever asks without it (a run's Try again)", async () => {
      const { trigger, transcribe } = harness({ jobs: [{ status: "failed", startedAt: at }] });
      await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
      expect(transcribe).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a project whose language is to be detected ('auto'): that is a choice", async () => {
    // The producer turns "auto" into no hint (`languageHints`); refusing it
    // here would leave every clips run on the default stuck at "transcribing".
    const { trigger, transcribe } = harness({ project: { sourceLanguage: "auto" } });
    await expect(trigger.maybeEnqueue("01MEDIA")).resolves.toEqual({ jobId: "01JOB" });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ languages: ["auto"] }));
  });
});
