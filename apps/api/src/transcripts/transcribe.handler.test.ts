import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_LOGGED_CORRECTIONS,
  retentionClassOf,
  submissionsFrom,
  TranscribeCompletionHandler,
} from "./transcribe.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { MemoryGlossarySource } from "./postprocess/index.js";
import type { TranscribeResult } from "./transcribe.handler.js";
import type { PersistTranscriptInput, TranscriptsRepository } from "./transcripts.repository.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { EdgService } from "../edg/index.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { JobEventsService } from "../jobs/job-events.service.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { Job } from "@prisma/client";

const JOB_ID = "01JCJOB000000000000000000A";
const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPROJECT000000000000000";
const TRANSCRIPT = "01JCTRANSCRIPT0000000000000";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    workspaceId: WS,
    projectId: PROJECT,
    type: "ai.transcribe",
    status: "running",
    priority: 5,
    progress: 90,
    etaMs: null,
    params: { transcriptId: TRANSCRIPT, mediaId: "01JCMEDIA00000000000000000", hints: [] },
    result: null,
    error: null,
    jobKey: `transcribe:${PROJECT}`,
    attemptId: "01JCATTEMPT0000000000000A",
    attemptNo: 1,
    maxQueueWaitMs: 600_000,
    creditsChargedTenths: 100,
    creditHoldId: "hold-1",
    provider: null,
    model: null,
    costMinor: null,
    egressBytes: null,
    queuedAt: new Date("2026-09-02T10:00:00.000Z"),
    startedAt: new Date("2026-09-02T10:00:05.000Z"),
    finishedAt: null,
    ...overrides,
  } as Job;
}

/** A two-chunk Hinglish completion, shaped exactly as A09's `_result` sends it. */
function result(overrides: Partial<TranscribeResult> = {}): Record<string, unknown> {
  return {
    transcriptId: TRANSCRIPT,
    mediaId: "01JCMEDIA00000000000000000",
    language: "hi",
    provider: "sarvam",
    model: "saarika-v2",
    durationMs: 600_000,
    chunks: [
      {
        chunkIdx: 0,
        startMs: 0,
        endMs: 3_000,
        nextWordSeq: 3,
        words: [
          { wid: "0:0", s: 320.4, e: 768.6, t: "Bhai", sp: "SPEAKER_01" },
          { wid: "0:1", s: 808, e: 1_256, t: "matlab", sp: "SPEAKER_01" },
          { wid: "0:2", s: 1_296, e: 2_100, t: "Akshara", sp: "SPEAKER_01" },
        ],
      },
      {
        chunkIdx: 1,
        startMs: 3_000,
        endMs: 6_000,
        nextWordSeq: 2,
        words: [
          { wid: "1:0", s: 3_500, e: 3_900, t: "haan", sp: "SPEAKER_02" },
          { wid: "1:1", s: 3_940, e: 4_400, t: "bilkul", sp: "SPEAKER_02" },
        ],
      },
    ],
    providerSubmissions: [
      {
        provider: "sarvam",
        endpoint: "https://api.sarvam.ai/speech-to-text",
        artefact: "audio16k",
        externalRef: "req-42",
        region: "ap-south-1",
        retentionClass: "zero",
      },
    ],
    ...overrides,
  } as unknown as Record<string, unknown>;
}

interface Harness {
  handler: TranscribeCompletionHandler;
  persist: ReturnType<typeof vi.fn>;
  findProject: ReturnType<typeof vi.fn>;
  initialise: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  terms: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
  emit: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const persist = vi.fn(async (input: PersistTranscriptInput) => ({
    transcript: { id: input.transcriptId },
    chunks: input.chunks.length,
    words: input.chunks.reduce((total, chunk) => total + chunk.words.length, 0),
    submissions: input.submissions.length,
  }));
  const initialise = vi.fn(async () => ({
    edgId: "01JCEDG000000000000000000A",
    revision: 1,
    segments: 4,
    created: true,
  }));
  const append = vi.fn(async () => undefined);
  const terms = vi.fn(async () => []);
  const findProject = vi.fn(async () => ({
    aspect: "r9x16",
    mediaAssets: [{ width: 1080, height: 1920 }],
  }));
  const registry = new JobCompletionRegistry();
  const emit = vi.fn();

  const handler = new TranscribeCompletionHandler(
    { project: { findFirst: findProject } } as unknown as PrismaService,
    { persist } as unknown as TranscriptsRepository,
    { initialise } as unknown as EdgService,
    { terms } as unknown as MemoryGlossarySource,
    { append } as unknown as JobEventsService,
    registry,
    { emit } as unknown as EventEmitter2,
  );
  return { handler, persist, initialise, append, terms, findProject, registry, emit };
}

function context(overrides: Partial<JobCompletionContext> = {}): JobCompletionContext {
  return {
    job: job(),
    attemptId: "01JCATTEMPT0000000000000A",
    result: result(),
    usage: { provider: "sarvam", model: "saarika-v2", mediaSeconds: 600 },
    completion: { status: "succeeded" },
    ...overrides,
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("TranscribeCompletionHandler", () => {
  it("owns `ai.transcribe` and registers itself at boot", () => {
    expect(h.handler.jobType).toBe("ai.transcribe");
    h.handler.onModuleInit();
    expect(h.registry.handlerFor("ai.transcribe")).toBe(h.handler);
  });

  it("persists every chunk with integer word timings and the worker's nextWordSeq", async () => {
    await h.handler.handle(context());

    const written = h.persist.mock.calls[0]?.[0] as PersistTranscriptInput;
    expect(written.transcriptId).toBe(TRANSCRIPT);
    expect(written.projectId).toBe(PROJECT);
    expect(written.workspaceId).toBe(WS);
    expect(written.jobId).toBe(JOB_ID);
    expect(written.revision).toBe(1);
    expect(written.chunks.map((chunk) => chunk.chunkIdx)).toEqual([0, 1]);

    for (const chunk of written.chunks) {
      for (const word of chunk.words) {
        expect(Number.isInteger(word.s), `${word.wid}.s`).toBe(true);
        expect(Number.isInteger(word.e), `${word.wid}.e`).toBe(true);
      }
    }
    // 320.4 → 320, 768.6 → 769.
    expect(written.chunks[0]?.words[0]).toMatchObject({ wid: "0:0", s: 320, e: 769 });
    // The worker's own allocation counter survives the round trip: ids are never
    // reused, so a chunk that issued more ids than it kept words must say so.
    expect(written.chunks.map((entry) => entry.nextWordSeq)).toEqual([3, 2]);
  });

  it("emits transcript.completed once the transcript is persisted (B14b)", async () => {
    await h.handler.handle(context());

    expect(h.emit).toHaveBeenCalledWith("transcript.completed", {
      workspaceId: WS,
      projectId: PROJECT,
      transcriptId: TRANSCRIPT,
      jobId: JOB_ID,
    });
  });

  it("records the two-signal language verdict rather than the provider's alone", async () => {
    await h.handler.handle(context());
    const written = h.persist.mock.calls[0]?.[0] as PersistTranscriptInput;

    // The provider said `hi`; the words are Roman, so the transcript is Hinglish.
    expect(written.language).toBe("hi-Latn");
    expect(written.detectedLanguages.map((entry) => entry.source)).toEqual(["provider", "script"]);
    expect(written.detectedLanguages[0]?.language).toBe("hi");
  });

  it("normalises speakers across chunks before the document is initialised", async () => {
    await h.handler.handle(context());
    const written = h.persist.mock.calls[0]?.[0] as PersistTranscriptInput;
    expect(written.chunks.flatMap((chunk) => chunk.words.map((word) => word.sp))).toEqual([
      "s1",
      "s1",
      "s1",
      "s2",
      "s2",
    ]);
    expect(h.initialise.mock.calls[0]?.[1]).toMatchObject({
      speakers: [{ id: "s1" }, { id: "s2" }],
    });
  });

  it("applies the request's glossary hints to the transcript", async () => {
    const withHints = job({
      params: { transcriptId: TRANSCRIPT, hints: ["Aksharo"] },
    });
    await h.handler.handle(context({ job: withHints }));
    const written = h.persist.mock.calls[0]?.[0] as PersistTranscriptInput;
    expect(written.chunks[0]?.words[2]?.t).toBe("Aksharo");
  });

  it("asks the consent-gated source for the workspace's remembered spellings", async () => {
    await h.handler.handle(context());
    expect(h.terms).toHaveBeenCalledWith(WS);
  });

  it("initialises the editing document from the post-processed words", async () => {
    await h.handler.handle(context());
    const [projectId, init] = h.initialise.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe(PROJECT);
    expect(init).toMatchObject({
      transcriptId: TRANSCRIPT,
      language: "hi-Latn",
      source: "worker",
      dropFillers: true,
    });
  });

  it("writes the corrections log as a job event", async () => {
    await h.handler.handle(context());
    const event = h.append.mock.calls[0]?.[0] as {
      name: string;
      data: { transcriptId: string; steps: string[]; correctionCount: number };
    };
    expect(event.name).toBe("transcript.postprocessed");
    expect(event.data.transcriptId).toBe(TRANSCRIPT);
    expect(event.data.steps).toContain("speakers");
    expect(event.data.correctionCount).toBeGreaterThan(0);
  });

  it("reports what landed and what to settle", async () => {
    const outcome = await h.handler.handle(context());
    expect(outcome.data).toMatchObject({
      transcriptId: TRANSCRIPT,
      revision: 1,
      language: "hi-Latn",
      chunks: 2,
      words: 5,
      segments: 4,
      edgCreated: true,
      providerSubmissions: 1,
    });
    // 600 media seconds is 10 minutes: 100 tenths, which is exactly the hold.
    expect(outcome.actualTenths).toBe(100);
  });

  it("settles less when the worker decoded less than was held", async () => {
    const outcome = await h.handler.handle(
      context({ usage: { mediaSeconds: 300, provider: "sarvam" } }),
    );
    expect(outcome.actualTenths).toBe(50);
  });

  it("never settles more than the hold, whatever the worker claims", async () => {
    const outcome = await h.handler.handle(
      context({ job: job({ creditsChargedTenths: 20 }), usage: { mediaSeconds: 9_999 } }),
    );
    expect(outcome.actualTenths).toBe(20);
  });

  it("is idempotent: two runs write the same rows", async () => {
    await h.handler.handle(context());
    await h.handler.handle(context());
    const first = h.persist.mock.calls[0]?.[0] as PersistTranscriptInput;
    const second = h.persist.mock.calls[1]?.[0] as PersistTranscriptInput;
    expect(second.transcriptId).toBe(first.transcriptId);
    expect(second.revision).toBe(first.revision);
    expect(JSON.stringify(second.chunks)).toBe(JSON.stringify(first.chunks));
  });

  it("refuses a completion whose result is not a transcript", async () => {
    await expect(h.handler.handle(context({ result: { language: "hi" } }))).rejects.toThrow();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("refuses a completion with no project or no transcript id", async () => {
    await expect(h.handler.handle(context({ job: job({ projectId: null }) }))).rejects.toThrow(
      /no project/,
    );

    await expect(
      h.handler.handle(
        context({
          job: job({ params: {} }),
          result: { ...result(), transcriptId: undefined },
        }),
      ),
    ).rejects.toThrow(/transcriptId/);
  });

  it("falls back to the job payload's transcript id when the worker drops it", async () => {
    await h.handler.handle(context({ result: { ...result(), transcriptId: undefined } }));
    expect((h.persist.mock.calls[0]?.[0] as PersistTranscriptInput).transcriptId).toBe(TRANSCRIPT);
  });

  it("caps the corrections it carries on the event", () => {
    expect(MAX_LOGGED_CORRECTIONS).toBeGreaterThan(0);
  });
});

describe("provider submissions", () => {
  it("records every external call the worker reported", () => {
    const rows = submissionsFrom(
      {
        providerSubmissions: [
          {
            provider: "sarvam",
            endpoint: "https://api.sarvam.ai/stt",
            artefact: "audio16k",
            externalRef: "req-42",
            region: "ap-south-1",
            retentionClass: "zero",
          },
        ],
      } as unknown as TranscribeResult,
      context(),
    );
    expect(rows).toEqual([
      {
        provider: "sarvam",
        endpoint: "https://api.sarvam.ai/stt",
        region: "ap-south-1",
        externalRef: "req-42",
        artefactKind: "audio16k",
        retentionClass: "zero_retention",
      },
    ]);
  });

  it("writes one synthetic row when a provider forgot to record its own call", () => {
    const rows = submissionsFrom(
      { providerSubmissions: [], provider: "assemblyai" } as unknown as TranscribeResult,
      context(),
    );
    expect(rows).toEqual([
      {
        provider: "assemblyai",
        endpoint: null,
        region: null,
        externalRef: null,
        artefactKind: "audio16k",
        retentionClass: "vendor_default",
      },
    ]);
  });

  it("falls back to `usage.provider` and then to nothing", () => {
    expect(
      submissionsFrom({ providerSubmissions: [] } as unknown as TranscribeResult, context()),
    ).toHaveLength(1);
    expect(
      submissionsFrom(
        { providerSubmissions: [] } as unknown as TranscribeResult,
        context({ usage: undefined }),
      ),
    ).toEqual([]);
  });

  it("maps a vendor's retention wording onto the enum, defaulting safely", () => {
    expect(retentionClassOf("zero")).toBe("zero_retention");
    expect(retentionClassOf("SHORT")).toBe("short_retention");
    expect(retentionClassOf("vendor_default")).toBe("vendor_default");
    // An unrecognised promise is not a promise this system will make.
    expect(retentionClassOf("thirty-days")).toBe("vendor_default");
    expect(retentionClassOf(undefined)).toBe("vendor_default");
  });
});
