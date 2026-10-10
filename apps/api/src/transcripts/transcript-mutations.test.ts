import { describe, expect, it, vi, beforeEach } from "vitest";

import { TranscriptsService } from "./transcripts.service.js";
import { AppException } from "../common/errors/error-codes.js";

describe("Transcript Mutations (08-inline-subtitle-editor)", () => {
  let service: TranscriptsService;
  let mockPrisma: any;
  let mockRepository: any;
  let mockJobs: any;
  let mockEdg: any;
  let mockMemory: any;
  let mockDocuments: any;
  let mockProbes: any;

  const mockChunkWords = [
    { wid: "0:0", id: "0:0", t: "Hello", text: "Hello", s: 0, e: 400, scripts: { roman: "Hello" } },
    { wid: "0:1", id: "0:1", t: "Dikshant", text: "Dikshant", s: 450, e: 900, scripts: { roman: "Dikshant" } },
    { wid: "0:2", id: "0:2", t: "welcome", text: "welcome", s: 950, e: 1400, scripts: { roman: "welcome" } },
    { wid: "0:3", id: "0:3", t: "to", text: "to", s: 1420, e: 1600, scripts: { roman: "to" } },
    { wid: "0:4", id: "0:4", t: "Aksharo", text: "Aksharo", s: 1650, e: 2200, scripts: { roman: "Aksharo" } },
  ];

  const mockChunkRow = {
    id: "chunk_01",
    transcriptId: "tr_123",
    revision: 1,
    chunkIdx: 0,
    startMs: 0,
    endMs: 2200,
    words: JSON.parse(JSON.stringify(mockChunkWords)),
  };

  const mockTranscript = {
    id: "tr_123",
    projectId: "proj_abc",
    language: "en",
    currentRevision: 1,
    project: {
      id: "proj_abc",
      workspaceId: "ws_valid",
      deletedAt: null,
    },
  };

  beforeEach(() => {
    mockPrisma = {
      transcript: {
        findUnique: vi.fn().mockResolvedValue(mockTranscript),
        update: vi.fn().mockImplementation(({ data }) => ({
          ...mockTranscript,
          currentRevision: mockTranscript.currentRevision + 1,
        })),
      },
      project: {
        findFirst: vi.fn().mockResolvedValue(mockTranscript.project),
      },
      transcriptChunk: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    mockRepository = {
      allChunks: vi.fn().mockResolvedValue([JSON.parse(JSON.stringify(mockChunkRow))]),
      latest: vi.fn().mockResolvedValue(mockTranscript),
    };

    mockJobs = {};
    mockEdg = {
      document: vi.fn().mockResolvedValue({
        revision: 1,
        segments: [
          { id: "seg_1", startMs: 0, endMs: 2200, startWordId: "0:0", endWordId: "0:4" },
        ],
      }),
      applyOps: vi.fn().mockResolvedValue({ revision: 2 }),
    };
    mockMemory = {};
    mockDocuments = {};
    mockProbes = {};

    service = new TranscriptsService(
      mockPrisma,
      mockRepository,
      mockJobs,
      mockEdg,
      mockMemory,
      mockDocuments,
      mockProbes,
    );
  });

  describe("updateWord", () => {
    it("updates word spelling and preserves exact millisecond timing anchors", async () => {
      const result = await service.updateWord({
        idOrProjectId: "tr_123",
        wordId: "0:1",
        workspaceId: "ws_valid",
        data: {
          text: "Deekshant",
        },
      });

      expect(result.success).toBe(true);
      expect(result.wordId).toBe("0:1");
      expect(result.text).toBe("Deekshant");
      expect(mockPrisma.transcriptChunk.update).toHaveBeenCalled();

      // Check saved words
      const updateCall = mockPrisma.transcriptChunk.update.mock.calls[0][0];
      const savedWords = updateCall.data.words;
      const updatedWord = savedWords.find((w: any) => w.wid === "0:1");
      expect(updatedWord.t).toBe("Deekshant");
      expect(updatedWord.s).toBe(450); // Timing untouched
      expect(updatedWord.e).toBe(900); // Timing untouched
    });

    it("updates word emphasis, emoji, and highlight color", async () => {
      const result = await service.updateWord({
        idOrProjectId: "tr_123",
        wordId: "0:4",
        workspaceId: "ws_valid",
        data: {
          isEmphasized: true,
          emoji: "🔥",
          color: "#FF5500",
        },
      });

      expect(result.success).toBe(true);
      expect(result.isEmphasized).toBe(true);
      expect(result.emoji).toBe("🔥");
      expect(result.color).toBe("#FF5500");

      const updateCall = mockPrisma.transcriptChunk.update.mock.calls[0][0];
      const savedWords = updateCall.data.words;
      const updatedWord = savedWords.find((w: any) => w.wid === "0:4");
      expect(updatedWord.isEmphasized).toBe(true);
      expect(updatedWord.emoji).toBe("🔥");
      expect(updatedWord.color).toBe("#FF5500");
    });

    it("rejects unauthorized workspace access (tenancy enforcement)", async () => {
      mockPrisma.transcript.findUnique.mockResolvedValueOnce({
        ...mockTranscript,
        project: { ...mockTranscript.project, workspaceId: "other_ws" },
      });
      mockPrisma.project.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.updateWord({
          idOrProjectId: "tr_123",
          wordId: "0:1",
          workspaceId: "attacker_ws",
          data: { text: "Hacked" },
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe("splitLine", () => {
    it("splits line at word index preserving timing continuity between lines", async () => {
      const result = await service.splitLine({
        idOrProjectId: "tr_123",
        workspaceId: "ws_valid",
        data: {
          wordId: "0:2",
        },
      });

      expect(result.success).toBe(true);
      expect(mockEdg.applyOps).toHaveBeenCalledWith(
        expect.objectContaining({
          ops: [
            expect.objectContaining({
              type: "SplitSegment",
              segmentId: "seg_1",
              atWordId: "0:2",
            }),
          ],
        }),
      );
    });

    it("splits line at chunk fallback preserving millisecond boundaries", async () => {
      mockEdg.document.mockRejectedValueOnce(new Error("No EDG"));

      const result = await service.splitLine({
        idOrProjectId: "tr_123",
        workspaceId: "ws_valid",
        data: {
          wordIndex: 2, // split at "welcome"
        },
      });

      expect(result.success).toBe(true);
      // Line 1: words 0..1 ("Hello", "Dikshant") -> 0 to 900 ms
      expect(result.line1.startMs).toBe(0);
      expect(result.line1.endMs).toBe(900);
      // Line 2: words 2..4 ("welcome", "to", "Aksharo") -> 950 to 2200 ms
      expect(result.line2.startMs).toBe(950);
      expect(result.line2.endMs).toBe(2200);
    });
  });

  describe("mergeLines", () => {
    it("merges adjacent lines expanding time bounds and preserving words", async () => {
      mockEdg.document.mockResolvedValue({
        revision: 2,
        segments: [
          { id: "seg_1", startMs: 0, endMs: 900, startWordId: "0:0", endWordId: "0:1" },
          { id: "seg_2", startMs: 950, endMs: 2200, startWordId: "0:2", endWordId: "0:4" },
        ],
      });

      const result = await service.mergeLines({
        idOrProjectId: "tr_123",
        workspaceId: "ws_valid",
        data: {
          lineId: "seg_1",
          nextLineId: "seg_2",
        },
      });

      expect(result.success).toBe(true);
      expect(result.mergedLine.startMs).toBe(0);
      expect(result.mergedLine.endMs).toBe(2200);
      expect(result.mergedLine.startWordId).toBe("0:0");
      expect(result.mergedLine.endWordId).toBe("0:4");

      expect(mockEdg.applyOps).toHaveBeenCalledWith(
        expect.objectContaining({
          ops: [
            expect.objectContaining({
              type: "MergeSegments",
              segmentIds: ["seg_1", "seg_2"],
            }),
          ],
        }),
      );
    });
  });

  describe("replaceAll", () => {
    it("replaces all matching words case-sensitively or case-insensitively", async () => {
      const result = await service.replaceAll({
        idOrProjectId: "tr_123",
        workspaceId: "ws_valid",
        data: {
          query: "Aksharo",
          replacement: "Akshara",
          caseSensitive: false,
          wholeWord: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(1);
      expect(result.matches[0]).toEqual({
        wordId: "0:4",
        before: "Aksharo",
        after: "Akshara",
      });

      const updateCall = mockPrisma.transcriptChunk.update.mock.calls[0][0];
      const savedWords = updateCall.data.words;
      const target = savedWords.find((w: any) => w.wid === "0:4");
      expect(target.t).toBe("Akshara");
      expect(target.s).toBe(1650); // Word timing preserved
      expect(target.e).toBe(2200); // Word timing preserved
    });

    it("supports regex find and replace", async () => {
      const result = await service.replaceAll({
        idOrProjectId: "tr_123",
        workspaceId: "ws_valid",
        data: {
          query: "^wel.*",
          replacement: "bienvenue",
          regex: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.replacedCount).toBe(1);
      expect(result.matches[0].after).toBe("bienvenue");
    });
  });
});

