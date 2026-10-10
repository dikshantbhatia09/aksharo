import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: vi.fn(),
}));

import {
  VOCAL_MASTER_FILTER,
  buildAudioCleanFilter,
  cleanAndUploadAudio,
  cleanAudio,
} from "./audio-clean.js";

const spawnMock = vi.mocked(spawn);
const existsSyncMock = vi.mocked(existsSync);

describe("audio-clean", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildAudioCleanFilter", () => {
    it("returns VOCAL_MASTER_FILTER with 80 Hz highpass and acompressor when vocalMaster is true", () => {
      const filter = buildAudioCleanFilter({ vocalMaster: true });
      expect(filter).toBe("highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=50");
      expect(filter).toBe(VOCAL_MASTER_FILTER);
    });

    it("returns balanced filter by default", () => {
      const filter = buildAudioCleanFilter({});
      expect(filter).toContain("highpass=f=80");
      expect(filter).toContain("afftdn=nf=-25");
      expect(filter).toContain("loudnorm=");
    });

    it("adjusts noise floor for aggressive level", () => {
      const filter = buildAudioCleanFilter({ level: "aggressive" });
      expect(filter).toContain("afftdn=nf=-35");
    });

    it("adjusts noise floor for low level", () => {
      const filter = buildAudioCleanFilter({ level: "low" });
      expect(filter).toContain("afftdn=nf=-18");
    });

    it("respects customFilter override", () => {
      const custom = "anull";
      expect(buildAudioCleanFilter({ customFilter: custom })).toBe(custom);
    });
  });

  describe("cleanAudio", () => {
    it("spawns ffmpeg with vocal master filter arguments and resolves on success", async () => {
      const mockProc = new EventEmitter() as ChildProcess;
      spawnMock.mockImplementation((_cmd, args) => {
        expect(args).toContain("-af");
        const afIndex = (args as string[]).indexOf("-af");
        expect((args as string[])[afIndex + 1]).toBe(VOCAL_MASTER_FILTER);
        expect(args).toContain("48000");

        process.nextTick(() => {
          mockProc.emit("close", 0);
        });
        return mockProc;
      });

      existsSyncMock.mockReturnValue(true);

      await cleanAudio({
        inputPath: "/tmp/input.wav",
        outputPath: "/tmp/audio_clean.wav",
        vocalMaster: true,
      });

      expect(spawnMock).toHaveBeenCalled();
    });

    it("rejects when ffmpeg exits with non-zero code", async () => {
      const mockProc = new EventEmitter() as ChildProcess;
      spawnMock.mockImplementation(() => {
        process.nextTick(() => {
          mockProc.emit("close", 1);
        });
        return mockProc;
      });
      existsSyncMock.mockReturnValue(false);

      await expect(
        cleanAudio({
          inputPath: "/tmp/in.wav",
          outputPath: "/tmp/out.wav",
        }),
      ).rejects.toThrow("FFmpeg audio clean exited with code 1");
    });
  });

  describe("cleanAndUploadAudio", () => {
    it("cleans audio, uploads to S3, and patches MediaAsset via callback", async () => {
      const mockProc = new EventEmitter() as ChildProcess;
      spawnMock.mockImplementation(() => {
        process.nextTick(() => {
          mockProc.emit("close", 0);
        });
        return mockProc;
      });
      existsSyncMock.mockReturnValue(true);

      const putFileMock = vi.fn().mockResolvedValue(102400);
      const patchMediaMock = vi.fn().mockResolvedValue(undefined);

      const s3Key = "ws/01JCWS0000000000000000000A/p/01JCPR0JECT000000000000000/media/01JCMED1A00000000000000000/audioClean.wav";
      const mediaId = "01JCMED1A00000000000000000";

      const result = await cleanAndUploadAudio({
        inputPath: "/tmp/audio48k.wav",
        outputPath: "/tmp/audio_clean.wav",
        vocalMaster: true,
        s3Store: { putFile: putFileMock },
        s3Key,
        mediaId,
        attemptId: "att-1",
        callbacks: { patchMedia: patchMediaMock },
      });

      expect(result.localPath).toBe("/tmp/audio_clean.wav");
      expect(result.audioCleanUri).toBe(s3Key);
      expect(result.bytesUploaded).toBe(102400);

      expect(putFileMock).toHaveBeenCalledWith({
        key: s3Key,
        file: "/tmp/audio_clean.wav",
        contentType: "audio/wav",
      });

      expect(patchMediaMock).toHaveBeenCalledWith(mediaId, "att-1", {
        audioCleanUri: s3Key,
        audioCleanKey: s3Key,
      });
    });
  });
});
