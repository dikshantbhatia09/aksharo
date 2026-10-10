import { describe, expect, it, vi, beforeEach } from "vitest";

import { formatTimestamp, ShowNotesService } from "./show-notes.service.js";

describe("ShowNotesService", () => {
  let service: ShowNotesService;
  let prismaMock: any;

  beforeEach(() => {
    prismaMock = {
      project: {
        findFirst: vi.fn(),
      },
      projectShowNotes: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    service = new ShowNotesService(prismaMock);
  });

  describe("formatTimestamp", () => {
    it("formats seconds into mm:ss and hh:mm:ss format", () => {
      expect(formatTimestamp(0)).toBe("00:00");
      expect(formatTimestamp(45)).toBe("00:45");
      expect(formatTimestamp(255)).toBe("04:15");
      expect(formatTimestamp(3600)).toBe("1:00:00");
      expect(formatTimestamp(3725)).toBe("1:02:05");
    });
  });

  describe("enforceYouTubeCompliance", () => {
    it("guarantees first timestamp starts at 00:00", () => {
      const input = [
        { timestamp: "01:00", title: "Later Topic", startSec: 60 },
        { timestamp: "02:00", title: "Another Topic", startSec: 120 },
        { timestamp: "03:00", title: "Third Topic", startSec: 180 },
      ];
      const result = service.enforceYouTubeCompliance(input);
      expect(result[0].startSec).toBe(0);
      expect(result[0].timestamp).toBe("00:00");
    });

    it("guarantees at least 3 timestamps", () => {
      const input = [
        { timestamp: "00:00", title: "Intro", startSec: 0 },
      ];
      const result = service.enforceYouTubeCompliance(input);
      expect(result.length).toBeGreaterThanOrEqual(3);
      expect(result[0].startSec).toBe(0);
      expect(result[1].startSec).toBeGreaterThanOrEqual(10);
      expect(result[2].startSec).toBeGreaterThan(result[1].startSec);
    });

    it("enforces minimum chapter length Delta t >= 10s", () => {
      const input = [
        { timestamp: "00:00", title: "Intro", startSec: 0 },
        { timestamp: "00:05", title: "Too Soon", startSec: 5 },
        { timestamp: "00:20", title: "Good Gap", startSec: 20 },
        { timestamp: "00:25", title: "Too Soon 2", startSec: 25 },
        { timestamp: "00:40", title: "Good Gap 2", startSec: 40 },
      ];
      const result = service.enforceYouTubeCompliance(input);
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i + 1].startSec - result[i].startSec).toBeGreaterThanOrEqual(10);
      }
    });
  });

  describe("generateFallbackShowNotes", () => {
    it("produces complete YouTube-compliant show notes package", () => {
      const words = [
        { text: "Welcome", startSec: 0, endSec: 1, speaker: "Host" },
        { text: "to", startSec: 1, endSec: 2, speaker: "Host" },
        { text: "the", startSec: 2, endSec: 3, speaker: "Host" },
        { text: "podcast.", startSec: 3, endSec: 4, speaker: "Host" },
        { text: "Today", startSec: 15, endSec: 16, speaker: "Guest" },
        { text: "we", startSec: 16, endSec: 17, speaker: "Guest" },
        { text: "discuss", startSec: 17, endSec: 18, speaker: "Guest" },
        { text: "growth.", startSec: 18, endSec: 19, speaker: "Guest" },
        { text: "In", startSec: 35, endSec: 36, speaker: "Host" },
        { text: "conclusion,", startSec: 36, endSec: 37, speaker: "Host" },
        { text: "consistency", startSec: 37, endSec: 38, speaker: "Host" },
        { text: "wins.", startSec: 38, endSec: 39, speaker: "Host" },
      ];

      const result = service.generateFallbackShowNotes("Episode 42: Scaling Startups", words, []);

      // YouTube chapters compliance
      expect(result.youtubeChapters.length).toBeGreaterThanOrEqual(3);
      expect(result.youtubeChapters[0].startSec).toBe(0);
      expect(result.youtubeChapters[0].timestamp).toBe("00:00");
      for (let i = 0; i < result.youtubeChapters.length - 1; i++) {
        expect(result.youtubeChapters[i + 1].startSec - result.youtubeChapters[i].startSec).toBeGreaterThanOrEqual(10);
      }

      // Executive Summary
      expect(result.summary.length).toBeGreaterThan(50);
      expect(result.summary.split("\n\n").length).toBeGreaterThanOrEqual(2);

      // Key Takeaways (5-8)
      expect(result.keyTakeaways.length).toBeGreaterThanOrEqual(5);
      expect(result.keyTakeaways.length).toBeLessThanOrEqual(8);

      // Notable Quotes (3)
      expect(result.notableQuotes.length).toBe(3);
      for (const q of result.notableQuotes) {
        expect(q.speaker).toBeDefined();
        expect(q.quote).toBeDefined();
        expect(q.timestampSec).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("getShowNotes and database integration", () => {
    it("returns null when no show notes exist yet", async () => {
      prismaMock.project.findFirst.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1" });
      prismaMock.projectShowNotes.findUnique.mockResolvedValue(null);

      const res = await service.getShowNotes("ws-1", "proj-1");
      expect(res).toBeNull();
    });

    it("returns formatted view when show notes exist", async () => {
      const now = new Date();
      prismaMock.project.findFirst.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1" });
      prismaMock.projectShowNotes.findUnique.mockResolvedValue({
        id: "sn-1",
        projectId: "proj-1",
        summary: "Executive Summary",
        keyTakeaways: ["Point 1", "Point 2", "Point 3"],
        notableQuotes: [{ speaker: "Host", quote: "Hello", timestampSec: 0 }],
        youtubeChapters: [
          { timestamp: "00:00", title: "Intro", startSec: 0 },
          { timestamp: "00:15", title: "Topic 1", startSec: 15 },
          { timestamp: "00:30", title: "Outro", startSec: 30 },
        ],
        createdAt: now,
      });

      const res = await service.getShowNotes("ws-1", "proj-1");
      expect(res).not.toBeNull();
      expect(res?.id).toBe("sn-1");
      expect(res?.summary).toBe("Executive Summary");
      expect(res?.youtubeChapters.length).toBe(3);
    });

    it("deletes show notes cleanly", async () => {
      prismaMock.project.findFirst.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1" });
      prismaMock.projectShowNotes.deleteMany.mockResolvedValue({ count: 1 });

      const res = await service.deleteShowNotes("ws-1", "proj-1");
      expect(res.success).toBe(true);
      expect(prismaMock.projectShowNotes.deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    });
  });
});

