import { readFile } from "node:fs/promises";

import { ulid } from "ulid";

import type {
  AlignRequest,
  AlignResponse,
  CleanRequest,
  CleanResponse,
  ProbeRequest,
  ProbeResponse,
  RenderRequest,
  RenderResponse,
  Segment,
  TranscribeRequest,
  TranscribeResponse,
  TranscribeStreamMessage,
  WordTiming,
} from "@montaj/engine-client";

import sampleTranscripts from "../fixtures/sample-transcripts.json";

import type { EngineBackend } from "./types.js";

interface FixtureTranscript {
  audioMatch: string;
  language: string;
  languageProbability: number;
  durationS: number;
  words: WordTiming[];
  segments: Segment[];
}

interface FixtureFile {
  v: 1;
  transcripts: FixtureTranscript[];
  default: Omit<FixtureTranscript, "audioMatch">;
}

const FIXTURES = sampleTranscripts as FixtureFile;

/**
 * `FakeBackend` (brief §4): deterministic transcripts/alignments from the
 * fixture manifest above, so every contract test in this WP runs without a
 * whisper.cpp/Silero/deep-filter/ffmpeg binary on disk — none may be
 * downloaded into this sandbox (brief "Reality"). It picks a fixture by
 * substring match on the request's `audio` field and falls back to
 * `FIXTURES.default`, so a test can select behaviour just by naming its
 * input file, and a request nobody wrote a fixture for still gets a
 * deterministic, non-empty answer instead of a special-cased error.
 */
export class FakeBackend implements EngineBackend {
  readonly kind = "fake" as const;

  transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    const fixture = pickFixture(request.audio);
    return Promise.resolve({
      language: request.language ?? fixture.language,
      languageProbability: fixture.languageProbability,
      durationS: fixture.durationS,
      model: request.model ?? "fake-asr",
      requestId: ulid(),
      words: fixture.words,
      segments: fixture.segments,
      engineVersions: this.engineVersions(),
      usage: { audioSeconds: fixture.durationS, model: request.model ?? "fake-asr" },
      backend: this.kind,
    });
  }

  async *transcribeStream(request: TranscribeRequest): AsyncGenerator<TranscribeStreamMessage> {
    const requestId = ulid();
    const fixture = pickFixture(request.audio);
    for (const segment of fixture.segments) {
      const words = fixture.words.filter((w) => w.start >= segment.start && w.end <= segment.end);
      yield { requestId, kind: "partial", words, segment };
    }
    const result = await this.transcribe(request);
    yield { requestId, kind: "done", result: { ...result, requestId } };
  }

  align(request: AlignRequest): Promise<AlignResponse> {
    const fixture = pickFixture(request.audio);
    // Deterministically align the requested word list against the fixture's
    // timing curve, stretched/compressed to the requested word count so a
    // caller that sends a different transcript still gets monotonic timings.
    const words = alignWordsToFixture(request.words, fixture, request.startS);
    return Promise.resolve({
      language: request.language,
      model: "fake-aligner",
      licence: "MIT",
      durationS: fixture.durationS,
      requestId: ulid(),
      words,
      skipped: [],
      engineVersions: this.engineVersions(),
      usage: { audioSeconds: fixture.durationS, model: "fake-aligner" },
      backend: this.kind,
    });
  }

  async clean(request: CleanRequest): Promise<CleanResponse> {
    // No real denoise: the fake path returns the same file untouched but
    // through the same contract shape a real deep-filter call would answer.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const stats = await readFile(request.audio).catch(() => undefined);
    return {
      audio: request.audio,
      model: "deep-filter",
      sampleRateHz: 48_000,
      durationS: stats === undefined ? 0 : estimateWavDurationS(stats),
      requestId: ulid(),
      engineVersions: this.engineVersions(),
      backend: this.kind,
    };
  }

  /**
   * `/probe` (brief C04b §2): deterministic fixture values keyed off the
   * matched transcript fixture's `durationS`, same "substring match, default
   * fallback" lookup `transcribe`/`align` already use — a 9:16 30fps clip,
   * stereo 48kHz, never HDR, so tests get non-null numbers without a real
   * ffprobe binary.
   */
  probe(request: ProbeRequest): Promise<ProbeResponse> {
    const fixture = pickFixture(request.path);
    return Promise.resolve({
      durationMs: Math.round(fixture.durationS * 1000),
      fps: 30,
      width: 1080,
      height: 1920,
      audioChannels: 2,
      audioSampleRateHz: 48_000,
      hdr: false,
      requestId: ulid(),
      engineVersions: this.engineVersions(),
      backend: this.kind,
    });
  }

  async render(request: RenderRequest): Promise<RenderResponse> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const raw = await readFile(request.drawCommandsPath, "utf8").catch(() => "[]");
    const frames = JSON.parse(raw) as unknown[];
    return {
      outputPath: request.outputPath,
      frameCount: frames.length,
      durationS: request.fps > 0 ? frames.length / request.fps : 0,
      requestId: ulid(),
      engineVersions: this.engineVersions(),
      backend: this.kind,
    };
  }

  engineVersions(): Record<string, string> {
    return {
      asr: "fake-asr-1.0.0",
      vad: "fake-vad-1.0.0",
      denoise: "fake-deep-filter-1.0.0",
      ffmpeg: "fake-ffmpeg-1.0.0",
    };
  }
}

function pickFixture(audio: string): Omit<FixtureTranscript, "audioMatch"> {
  const match = FIXTURES.transcripts.find((t) => audio.includes(t.audioMatch));
  return match ?? FIXTURES.default;
}

function alignWordsToFixture(
  words: string[],
  fixture: Omit<FixtureTranscript, "audioMatch">,
  startS: number,
): WordTiming[] {
  if (words.length === 0) return [];
  const totalSpan = Math.max(fixture.durationS, 0.001);
  const step = totalSpan / words.length;
  return words.map((word, index) => ({
    start: Number((startS + index * step).toFixed(3)),
    end: Number((startS + (index + 1) * step).toFixed(3)),
    word,
    probability: 1,
  }));
}

/** Rough estimate from a 16-bit PCM WAV's byte length, good enough for a fake response shape. */
function estimateWavDurationS(bytes: Buffer): number {
  const dataBytes = Math.max(0, bytes.length - 44);
  const bytesPerSecond = 16_000 * 2;
  return Number((dataBytes / bytesPerSecond).toFixed(3));
}
