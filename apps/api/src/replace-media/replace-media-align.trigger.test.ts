import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReplaceMediaAlignTrigger } from "./replace-media-align.trigger.js";

import type { Job } from "@prisma/client";

const PROJECT = "01JPROJECT0000000000000AA";
const MEDIA = "01JMEDIA00000000000000000";
const EDG_ID = "01JEDG000000000000000000A";

function parentJob(): Job {
  return {
    id: "01JPARENT0000000000000000",
    jobKey: "media.probe:media1",
    priority: 0,
  } as unknown as Job;
}

function makeTrigger() {
  const prisma = {
    mediaAsset: {
      findUnique: vi.fn(async () => ({
        id: MEDIA,
        projectId: PROJECT,
        needsRealign: true,
      })),
      update: vi.fn(async () => ({})),
    },
    edgDocument: {
      findUnique: vi.fn(async (): Promise<{ id: string } | null> => ({ id: EDG_ID })),
    },
  };
  const edgRepository = {
    projectionOf: vi.fn(async () => ({
      meta: { edgId: EDG_ID, projectId: PROJECT, revision: 1, schemaVersion: 2 },
      transcript: { transcriptId: "TR1", revision: 1, language: "hi-Latn", scripts: ["roman"] },
      segments: [
        { id: "SEG1", seq: "a0", startWordId: "0:0", endWordId: "0:0", startMs: 0, endMs: 400 },
      ],
    })),
    loadChunks: vi.fn(async () => [
      { chunkIdx: 0, startMs: 0, endMs: 400, words: [{ wid: "0:0", s: 0, e: 400, t: "namaste" }] },
    ]),
  };
  const jobs = {
    enqueueChild: vi.fn(async () => ({
      job: { id: "01JCHILD00000000000000000" },
      deduplicated: false,
    })),
  };

  const trigger = new ReplaceMediaAlignTrigger(
    prisma as never,
    edgRepository as never,
    jobs as never,
  );
  return { trigger, prisma, edgRepository, jobs };
}

describe("ReplaceMediaAlignTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing for a media item that never asked for a re-align", async () => {
    const { trigger, prisma, jobs } = makeTrigger();
    prisma.mediaAsset.findUnique = vi.fn(async () => ({
      id: MEDIA,
      projectId: PROJECT,
      needsRealign: false,
    }));

    const result = await trigger.maybeEnqueue(parentJob(), MEDIA);

    expect(result).toBeUndefined();
    expect(jobs.enqueueChild).not.toHaveBeenCalled();
  });

  it("does nothing for a project with no EDG document yet", async () => {
    const { trigger, prisma, jobs } = makeTrigger();
    prisma.edgDocument.findUnique = vi.fn(async () => null);

    const result = await trigger.maybeEnqueue(parentJob(), MEDIA);

    expect(result).toBeUndefined();
    expect(jobs.enqueueChild).not.toHaveBeenCalled();
  });

  it("enqueues ai.align with segments built from the current document, and clears needs_realign", async () => {
    const { trigger, prisma, jobs } = makeTrigger();

    const result = await trigger.maybeEnqueue(parentJob(), MEDIA);

    expect(result).toEqual({ jobId: "01JCHILD00000000000000000" });
    expect(jobs.enqueueChild).toHaveBeenCalledWith(
      expect.objectContaining({ id: "01JPARENT0000000000000000" }),
      expect.objectContaining({
        type: "ai.align",
        payload: expect.objectContaining({
          mediaId: MEDIA,
          mode: "replace_media",
          projectId: PROJECT,
          segments: [{ startMs: 0, endMs: 400, text: "namaste" }],
        }),
      }),
    );
    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: MEDIA },
      data: { needsRealign: false },
    });
  });

  it("does not clear needs_realign when the enqueue deduplicated onto an already-running job", async () => {
    const { trigger, prisma, jobs } = makeTrigger();
    jobs.enqueueChild = vi.fn(async () => ({
      job: { id: "01JCHILD00000000000000000" },
      deduplicated: true,
    }));

    await trigger.maybeEnqueue(parentJob(), MEDIA);

    expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
  });
});
