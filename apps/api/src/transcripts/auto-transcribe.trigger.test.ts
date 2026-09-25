import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutoTranscribeTrigger } from "./auto-transcribe.trigger.js";

import type { TranscriptDocumentService } from "./transcript-document.service.js";
import type { TranscriptsService } from "./transcripts.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

const READY_PRIMARY: {
  id: string;
  projectId: string;
  role: string;
  status: string;
  durationMs: number | null;
} = {
  id: "01MEDIA",
  projectId: "01PROJECT",
  role: "primary",
  status: "ready",
  durationMs: 20_200,
};

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

function harness(
  overrides: {
    media?: Partial<typeof READY_PRIMARY> | null;
    project?: Partial<typeof FRESH_PROJECT> | null;
    transcriptCount?: number;
    transcribe?: () => Promise<{ jobId: string }>;
    ensure?: () => Promise<{ status: string; edgId?: string }>;
  } = {},
) {
  const media = overrides.media === null ? null : { ...READY_PRIMARY, ...overrides.media };
  const project = overrides.project === null ? null : { ...FRESH_PROJECT, ...overrides.project };
  const transcribe = vi.fn(overrides.transcribe ?? (async () => ({ jobId: "01JOB" })));
  const prisma = {
    mediaAsset: { findUnique: vi.fn(async () => media) },
    project: { findFirst: vi.fn(async () => project) },
    transcript: { count: vi.fn(async () => overrides.transcriptCount ?? 0) },
  } as unknown as PrismaService;
  const ensure = vi.fn(overrides.ensure ?? (async () => ({ status: "created", edgId: "01EDG" })));
  const trigger = new AutoTranscribeTrigger(
    prisma,
    { transcribe } as unknown as TranscriptsService,
    { ensure } as unknown as TranscriptDocumentService,
  );
  return { trigger, transcribe, ensure };
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
    ["media still processing", { status: "probing" }],
    ["media with no measured duration", { durationMs: null }],
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
});
