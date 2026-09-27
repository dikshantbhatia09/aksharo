import { beforeEach, describe, expect, it, vi } from "vitest";

import { processProxy } from "./proxy.js";
import { mediaPrefix } from "../storage-keys.js";

import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";

/**
 * The early write-back of the ASR audio (clips pipeline W5), with ffmpeg and the
 * waveform stubbed so the ORDER of what the job does is the thing under test.
 *
 * `processors.test.ts` runs the same processor against real ffmpeg and checks
 * the artefacts; this checks when the API is told about them. Everything the
 * job does lands in one `steps` log — an extraction, an upload, a write-back,
 * the encode — so "before the encode" is an index comparison, not a timing.
 */

const probe = vi.hoisted(() => ({
  steps: [] as string[],
  /** Runs as the encode starts; a test can make the encode wait on something. */
  onEncode: async (): Promise<void> => undefined,
}));

vi.mock("../ffmpeg/derive.js", async (importOriginal) => {
  // The real `proxySize` and thumbnail spacing; only what spawns ffmpeg is stubbed.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    extractAudio: vi.fn(async (_context: unknown, sampleRate: number) => {
      probe.steps.push(`extract:${String(sampleRate)}`);
    }),
    encodeProxy: vi.fn(async () => {
      probe.steps.push("encode");
      await probe.onEncode();
      return { toneMapped: false };
    }),
    grabThumbnail: vi.fn(async () => true),
  };
});

vi.mock("../waveform.js", () => ({
  buildWaveform: vi.fn(async () => {
    probe.steps.push("waveform");
    return { peaks: [] };
  }),
}));

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const ATTEMPT = "01JCATTEMPT000000000000000";
const PREFIX = mediaPrefix(WS, PROJECT, MEDIA);

/** A probed source with both halves: the proxy job never probes again. */
const VIDEO_WITH_AUDIO = {
  durationMs: 3_000,
  hasVideo: true,
  hasAudio: true,
  width: 1280,
  height: 720,
  hdr: false,
};

function store(): ObjectStore {
  const record = async ({ key }: { readonly key: string }): Promise<number> => {
    probe.steps.push(`put:${key.slice(key.lastIndexOf("/") + 1)}`);
    return 100;
  };
  return {
    bucket: "montaj-derived",
    kind: "r2",
    presignGet: async () => "C:/fixtures/raw.mp4",
    putFile: record,
    putBody: record,
  };
}

function context(
  options: {
    readonly payload?: Record<string, unknown>;
    readonly patchMedia?: (patch: Record<string, unknown>) => Promise<void>;
    readonly signal?: AbortSignal;
  } = {},
): { context: JobContext; patchMedia: ReturnType<typeof vi.fn> } {
  const patchMedia = vi.fn(
    async (_mediaId: string, _attemptId: string, patch: Record<string, unknown>) => {
      probe.steps.push("patch");
      await (options.patchMedia ?? (async () => undefined))(patch);
    },
  );
  const payload = {
    mediaId: MEDIA,
    key: `${PREFIX}/raw.mp4`,
    ...(options.payload ?? VIDEO_WITH_AUDIO),
  };
  const derived = store();
  return {
    patchMedia,
    context: {
      settings: {
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        tempDir: undefined,
        sourceUrlTtlSeconds: 3_600,
        ffmpegTimeoutMs: 120_000,
      } as unknown as Settings,
      envelope: {
        jobId: "01JCJ0B0000000000000000000",
        attemptId: ATTEMPT,
        workspaceId: WS,
        projectId: PROJECT,
        priority: 3,
        jobKey: `media.proxy:${MEDIA}`,
        createdAt: "2026-09-27T00:00:00.000Z",
        payload,
      },
      payload: payload as never,
      derivedPrefix: PREFIX,
      raw: derived,
      derived,
      callbacks: { patchMedia } as unknown as JobContext["callbacks"],
      report: () => undefined,
      signal: options.signal ?? new AbortController().signal,
    },
  };
}

beforeEach(() => {
  probe.steps.length = 0;
  probe.onEncode = async () => undefined;
});

describe("processProxy — telling the API the ASR audio exists", () => {
  it("writes the audio key back as soon as it is stored, before the video encode starts", async () => {
    const { context: ctx, patchMedia } = context();
    await processProxy(ctx);

    // Exactly the key, under this asset's own prefix — no status: `ready`
    // stays the final write-back's, and means every artefact exists.
    expect(patchMedia).toHaveBeenCalledWith(MEDIA, ATTEMPT, {
      audio16kKey: `${PREFIX}/audio16k.wav`,
    });
    const at = (step: string) => probe.steps.indexOf(step);
    expect(at("put:audio16k.wav")).toBeGreaterThanOrEqual(0);
    // After the object exists (transcription may read it within the second)...
    expect(at("patch")).toBeGreaterThan(at("put:audio16k.wav"));
    // ...and before anything else the job still has to make.
    expect(at("patch")).toBeLessThan(at("extract:48000"));
    expect(at("patch")).toBeLessThan(at("encode"));
  });

  it("does not hold the encode on the API", async () => {
    // The write-back only finishes once the encode has started. A job that
    // waited for it before encoding would never finish.
    let encodeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encodeStarted = resolve;
    });
    probe.onEncode = async () => {
      encodeStarted();
    };
    let heard = false;
    const { context: ctx } = context({
      patchMedia: async () => {
        await started;
        heard = true;
      },
    });

    const outcome = await processProxy(ctx);
    // And the job does not report until the early write has settled.
    expect(heard).toBe(true);
    expect(outcome.mediaPatch).toMatchObject({ status: "ready" });
  }, 5_000);

  it("still finishes, with the key in the final write-back, when the early write fails", async () => {
    const { context: ctx, patchMedia } = context({
      patchMedia: async () => {
        throw new Error("/internal/media answered 503");
      },
    });
    const outcome = await processProxy(ctx);
    expect(patchMedia).toHaveBeenCalledTimes(1);
    expect(outcome.mediaPatch).toMatchObject({
      status: "ready",
      audio16kKey: `${PREFIX}/audio16k.wav`,
      audio48kKey: `${PREFIX}/audio48k.wav`,
      waveformKey: `${PREFIX}/waveform.json`,
      proxyKey: `${PREFIX}/proxy540.mp4`,
    });
  });

  it("says nothing early for a video with no audio: there is nothing to transcribe", async () => {
    const { context: ctx, patchMedia } = context({
      payload: { ...VIDEO_WITH_AUDIO, hasAudio: false },
    });
    await processProxy(ctx);
    expect(patchMedia).not.toHaveBeenCalled();
    expect(probe.steps).toContain("encode");
  });

  it("says nothing early for a job the API has already settled (a stopped run)", async () => {
    const stopped = new AbortController();
    stopped.abort("already_completed");
    const { context: ctx, patchMedia } = context({ signal: stopped.signal });
    // ffmpeg is stubbed here, so the job runs on; only the write is at issue.
    await processProxy(ctx).catch(() => undefined);
    expect(patchMedia).not.toHaveBeenCalled();
  });

  it("announces an audio-only upload's audio the same way, before its waveform", async () => {
    const { context: ctx, patchMedia } = context({
      payload: { durationMs: 2_000, hasVideo: false, hasAudio: true },
    });
    const outcome = await processProxy(ctx);
    expect(patchMedia).toHaveBeenCalledWith(MEDIA, ATTEMPT, {
      audio16kKey: `${PREFIX}/audio16k.wav`,
    });
    expect(probe.steps.indexOf("patch")).toBeLessThan(probe.steps.indexOf("waveform"));
    expect(probe.steps).not.toContain("encode");
    expect(outcome.mediaPatch).toMatchObject({ status: "ready" });
  });
});
