import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  TranscriptMutationsController,
  TranscriptsController,
} from "./transcripts.controller.js";

describe("TranscriptsController and TranscriptMutationsController", () => {
  let transcriptsController: TranscriptsController;
  let mutationsController: TranscriptMutationsController;
  let mockTranscriptsService: any;

  const mockPrincipal: any = {
    userId: "usr_1",
    workspaceId: "ws_1",
    role: "editor",
    kind: "user",
  };

  beforeEach(() => {
    mockTranscriptsService = {
      updateWord: vi.fn().mockResolvedValue({
        success: true,
        wordId: "0:1",
        text: "Aksharo",
        revision: 2,
      }),
      splitLine: vi.fn().mockResolvedValue({
        success: true,
        line1: { id: "seg_1" },
        line2: { id: "seg_2" },
        revision: 2,
      }),
      mergeLines: vi.fn().mockResolvedValue({
        success: true,
        mergedLine: { id: "seg_merged" },
        revision: 2,
      }),
      replaceAll: vi.fn().mockResolvedValue({
        success: true,
        replacedCount: 3,
        matches: [],
        revision: 2,
      }),
    };

    transcriptsController = new TranscriptsController(mockTranscriptsService);
    mutationsController = new TranscriptMutationsController(mockTranscriptsService);
  });

  describe("TranscriptMutationsController", () => {
    it("PATCH /:id/words/:wordId calls updateWord", async () => {
      const res = await mutationsController.updateWord(
        mockPrincipal,
        "tr_123",
        "0:1",
        { text: "Aksharo", isEmphasized: true },
      );

      expect(res.success).toBe(true);
      expect(mockTranscriptsService.updateWord).toHaveBeenCalledWith({
        idOrProjectId: "tr_123",
        wordId: "0:1",
        workspaceId: "ws_1",
        data: { text: "Aksharo", isEmphasized: true },
      });
    });

    it("POST /:id/lines/split calls splitLine", async () => {
      const res = await mutationsController.splitLine(
        mockPrincipal,
        "tr_123",
        { wordIndex: 2 },
      );

      expect(res.success).toBe(true);
      expect(mockTranscriptsService.splitLine).toHaveBeenCalledWith({
        idOrProjectId: "tr_123",
        workspaceId: "ws_1",
        data: { wordIndex: 2 },
      });
    });

    it("POST /:id/lines/merge calls mergeLines", async () => {
      const res = await mutationsController.mergeLines(
        mockPrincipal,
        "tr_123",
        { lineId: "seg_1", nextLineId: "seg_2" },
      );

      expect(res.success).toBe(true);
      expect(mockTranscriptsService.mergeLines).toHaveBeenCalledWith({
        idOrProjectId: "tr_123",
        workspaceId: "ws_1",
        data: { lineId: "seg_1", nextLineId: "seg_2" },
      });
    });

    it("POST /:id/replace-all calls replaceAll", async () => {
      const res = await mutationsController.replaceAll(
        mockPrincipal,
        "tr_123",
        { query: "foo", replacement: "bar" },
      );

      expect(res.success).toBe(true);
      expect(mockTranscriptsService.replaceAll).toHaveBeenCalledWith({
        idOrProjectId: "tr_123",
        workspaceId: "ws_1",
        data: { query: "foo", replacement: "bar" },
      });
    });
  });

  describe("TranscriptsController project aliases", () => {
    it("PATCH projects/:projectId/transcript/words/:wordId calls updateWord", async () => {
      const res = await transcriptsController.updateWord(
        mockPrincipal,
        "proj_123",
        "0:1",
        { text: "Aksharo" },
      );

      expect(res.success).toBe(true);
      expect(mockTranscriptsService.updateWord).toHaveBeenCalledWith({
        idOrProjectId: "proj_123",
        wordId: "0:1",
        workspaceId: "ws_1",
        data: { text: "Aksharo" },
      });
    });
  });
});

