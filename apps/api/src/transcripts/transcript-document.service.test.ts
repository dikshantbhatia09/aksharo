import { describe, expect, it, vi } from "vitest";

import { TranscriptDocumentService } from "./transcript-document.service.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { EdgInitInput, EdgService } from "../edg/edg.service.js";

/**
 * The invariant: a project with a transcript has an editing document.
 *
 * The defect (2026-09-25): `media.clip` cloned a transcript slice onto every
 * repurposed clip's child project and never built its document, so each clip
 * opened onto an editor that bounced between `/edg` (`edg/not_initialised`) and
 * `/transcription-state` (`ready`) several times a second, forever.
 */

const WORDS = [
  { wid: "0:0", s: 200, e: 1_200, t: "Welcome" },
  { wid: "0:1", s: 1_200, e: 1_700, t: "to" },
  { wid: "0:2", s: 1_700, e: 2_200, t: "this" },
];

interface Setup {
  project?: {
    aspect: string;
    scripts: string[];
    edgDocument: { id: string } | null;
    mediaAssets: { width: number | null; height: number | null }[];
  } | null;
  transcript?: { id: string; language: string } | null;
  chunkRows?: unknown[];
}

function harness(setup: Setup = {}) {
  const project =
    setup.project === undefined
      ? {
          id: "01PROJECT",
          aspect: "r9x16",
          scripts: ["roman"],
          edgDocument: null,
          mediaAssets: [{ width: 1080, height: 1920 }],
        }
      : setup.project === null
        ? null
        : { id: "01PROJECT", ...setup.project };
  const transcript =
    setup.transcript === undefined ? { id: "01TRANSCRIPT", language: "hi-Latn" } : setup.transcript;
  const chunkRows = setup.chunkRows ?? [
    {
      id: "01CHUNK",
      transcriptId: "01TRANSCRIPT",
      revision: 1,
      chunkIdx: 0,
      startMs: 0,
      endMs: 4_000,
      words: WORDS,
      nextWordSeq: 3,
    },
  ];

  const prisma = {
    project: { findFirst: vi.fn(async () => project) },
    transcript: { findFirst: vi.fn(async () => transcript) },
    transcriptChunk: { findMany: vi.fn(async () => chunkRows) },
  } as unknown as PrismaService;

  const initialise = vi.fn(async (_projectId: string, _input: EdgInitInput) => ({
    edgId: "01EDG",
    revision: 1,
    segments: 1,
    created: true,
  }));
  const service = new TranscriptDocumentService(prisma, { initialise } as unknown as EdgService);
  return { service, initialise };
}

describe("TranscriptDocumentService.ensure", () => {
  it("builds the document from the stored transcript's words", async () => {
    const { service, initialise } = harness();

    await expect(service.ensure("01PROJECT")).resolves.toEqual({
      status: "created",
      edgId: "01EDG",
      segments: 1,
    });

    expect(initialise).toHaveBeenCalledTimes(1);
    const [projectId, input] = initialise.mock.calls[0]!;
    expect(projectId).toBe("01PROJECT");
    expect(input.transcriptId).toBe("01TRANSCRIPT");
    expect(input.language).toBe("hi-Latn");
    expect(input.scripts).toEqual(["roman"]);
    expect(input.chunks.flatMap((chunk) => chunk.words).map((word) => word.t)).toEqual([
      "Welcome",
      "to",
      "this",
    ]);
    // Built by the worker path, like every other document born of a transcript.
    expect(input.source).toBe("worker");
  });

  it("leaves an existing document alone", async () => {
    const { service, initialise } = harness({
      project: {
        aspect: "r9x16",
        scripts: [],
        edgDocument: { id: "01EXISTING" },
        mediaAssets: [],
      },
    });
    await expect(service.ensure("01PROJECT")).resolves.toEqual({
      status: "exists",
      edgId: "01EXISTING",
    });
    expect(initialise).not.toHaveBeenCalled();
  });

  it("does nothing for a project with no transcript", async () => {
    const { service, initialise } = harness({ transcript: null });
    await expect(service.ensure("01PROJECT")).resolves.toEqual({ status: "no_transcript" });
    expect(initialise).not.toHaveBeenCalled();
  });

  it("does nothing for a deleted or missing project", async () => {
    const { service, initialise } = harness({ project: null });
    await expect(service.ensure("01PROJECT")).resolves.toEqual({ status: "no_transcript" });
    expect(initialise).not.toHaveBeenCalled();
  });

  // A clip of music or silence has no words; it must still open, with no captions,
  // rather than sit on a waiting screen.
  it("still builds a document for a transcript with no words", async () => {
    const { service, initialise } = harness({ chunkRows: [] });
    await expect(service.ensure("01PROJECT")).resolves.toMatchObject({ status: "created" });
    expect(initialise.mock.calls[0]![1].chunks).toEqual([]);
  });
});
