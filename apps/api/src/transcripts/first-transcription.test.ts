import { describe, expect, it, vi } from "vitest";

import {
  AUTO_DETECT_LANGUAGE,
  audioReadyEarly,
  firstTranscriptionCanStart,
  firstTranscriptionJobKey,
  languageHints,
} from "./first-transcription.js";
import { TRANSCRIPT_ERROR_CODES } from "./transcripts.errors.js";
import { TranscriptsService } from "./transcripts.service.js";
import { AppException } from "../common/errors/error-codes.js";

import type { TranscribableMedia } from "./first-transcription.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { MemoryService } from "../memory/memory.service.js";

/**
 * When a first transcription may start (clips pipeline W5: on the ASR audio,
 * ahead of the video encode) and what it is asked to hear ("auto" = detect).
 */

const AUDIO_KEY = "ws/01WS/p/01PROJECT/media/01MEDIA/audio16k.wav";

const EARLY: TranscribableMedia = {
  status: "probing",
  durationMs: 2_076_000,
  audio16kKey: AUDIO_KEY,
  hasAudio: true,
};

describe("audioReadyEarly / firstTranscriptionCanStart", () => {
  it("lets a first transcription start on the audio while the video still encodes", () => {
    expect(audioReadyEarly(EARLY)).toBe(true);
    expect(firstTranscriptionCanStart(EARLY)).toBe(true);
  });

  it("still starts on ready media, as it always did", () => {
    expect(firstTranscriptionCanStart({ ...EARLY, status: "ready" })).toBe(true);
    // Including ready media with no audio key: that is the producer's and the
    // worker's to answer, exactly as before.
    expect(firstTranscriptionCanStart({ ...EARLY, status: "ready", audio16kKey: null })).toBe(true);
  });

  it.each<[string, Partial<TranscribableMedia>]>([
    ["no audio written back yet", { audio16kKey: null }],
    ["no measured duration to quote on", { durationMs: null }],
    ["a zero duration", { durationMs: 0 }],
    ["a probe that never ran (has_audio unset)", { hasAudio: null }],
    ["a probe that found no audio", { hasAudio: false }],
    // A re-cut lands new bytes on the row without clearing the old keys.
    ["bytes landed but not probed yet", { status: "uploaded" }],
    ["an upload still arriving", { status: "uploading" }],
    ["failed media", { status: "failed" }],
  ])("waits on %s", (_label, change) => {
    expect(audioReadyEarly({ ...EARLY, ...change })).toBe(false);
    expect(firstTranscriptionCanStart({ ...EARLY, ...change })).toBe(false);
  });

  it("names a first transcription's job by project and media, the key every starter dedupes on", () => {
    expect(firstTranscriptionJobKey("01PROJECT", "01MEDIA")).toBe("transcribe:01PROJECT:01MEDIA");
  });
});

describe("languageHints", () => {
  it("sends no hint for 'auto': detecting is the absence of a hint", () => {
    expect(AUTO_DETECT_LANGUAGE).toBe("auto");
    expect(languageHints(["auto"])).toEqual([]);
    expect(languageHints([" AUTO "])).toEqual([]);
  });

  it("keeps real tags, best first, and drops blanks", () => {
    expect(languageHints(["hi-Latn", "", "auto", "en"])).toEqual(["hi-Latn", "en"]);
    expect(languageHints(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

interface MediaRow extends TranscribableMedia {
  readonly id: string;
  readonly projectId: string;
  readonly role: string;
}

function service(media: Partial<MediaRow> = {}) {
  const row: MediaRow = {
    id: "01MEDIA",
    projectId: "01PROJECT",
    role: "primary",
    ...EARLY,
    ...media,
  };
  const enqueue = vi.fn(async (input: { params: Record<string, unknown>; jobKey: string }) => ({
    job: { id: "01JOB", status: "queued", params: input.params },
    deduplicated: false,
  }));
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({
        id: "01PROJECT",
        workspaceId: "01WS",
        sourceLanguage: "auto",
        deletedAt: null,
      })),
    },
    mediaAsset: { findFirst: vi.fn(async () => row) },
    edgDocument: { findUnique: vi.fn(async () => ({ revision: 1 })) },
  } as unknown as PrismaService;
  const transcripts = new TranscriptsService(
    prisma,
    {} as never,
    { enqueue } as unknown as JobsService,
    {} as never,
    { glossaryTermsFor: vi.fn(async () => []) } as unknown as MemoryService,
    {} as never,
    {} as never,
  );
  return { transcripts, enqueue };
}

const REQUEST = { projectId: "01PROJECT", workspaceId: "01WS", userId: "01USER" };

describe("TranscriptsService.transcribe — the first transcription", () => {
  it("starts on the audio the proxy wrote back, reading exactly that file", async () => {
    const { transcripts, enqueue } = service();
    await transcripts.transcribe({ ...REQUEST, languages: ["hi-Latn"] });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai.transcribe",
        jobKey: "transcribe:01PROJECT:01MEDIA",
        params: expect.objectContaining({
          mediaId: "01MEDIA",
          audioKey: AUDIO_KEY,
          durationMs: 2_076_000,
          language: "hi-Latn",
          codeMix: true,
        }),
      }),
    );
  });

  it("refuses media whose audio is not back yet with the same 409 as before", async () => {
    const { transcripts, enqueue } = service({ audio16kKey: null });
    const refusal = await transcripts
      .transcribe({ ...REQUEST, languages: ["en"] })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe(TRANSCRIPT_ERROR_CODES.mediaNotReady);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("sends 'auto' as no language at all, so the worker detects it", async () => {
    // A hint wins outright in the worker's LID and in the API's own
    // post-processing, which would record the transcript — and the project —
    // as being in a language called "auto".
    const { transcripts, enqueue } = service();
    await transcripts.transcribe({ ...REQUEST, languages: ["auto"] });
    const params = enqueue.mock.calls[0]?.[0].params ?? {};
    expect(params).not.toHaveProperty("language");
    expect(params).not.toHaveProperty("languages");
    expect(params["codeMix"]).toBe(false);
  });

  it("keeps a real tag named next to 'auto'", async () => {
    const { transcripts, enqueue } = service();
    await transcripts.transcribe({ ...REQUEST, languages: ["auto", "hi"] });
    const params = enqueue.mock.calls[0]?.[0].params ?? {};
    expect(params["language"]).toBe("hi");
    expect(params).not.toHaveProperty("languages");
  });
});

describe("TranscriptsService.retranscribe — no early start", () => {
  it("still waits for ready media: it has a transcript to fall back on", async () => {
    const { transcripts, enqueue } = service();
    const refusal = await transcripts
      .retranscribe({ ...REQUEST, languages: ["en"] })
      .catch((error: unknown) => error);
    expect((refusal as AppException).code).toBe(TRANSCRIPT_ERROR_CODES.mediaNotReady);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("goes ahead on ready media", async () => {
    const { transcripts, enqueue } = service({ status: "ready" });
    await transcripts.retranscribe({ ...REQUEST, languages: ["en"] });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
