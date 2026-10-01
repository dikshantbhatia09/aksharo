import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AiVoiceoverPayloadSchema,
  AiVoiceoverResultSchema,
  VOICEOVER_KEY_PATTERN,
  VOICEOVER_LANGUAGES,
  VOICEOVER_LANGUAGE_NAMES,
  VOICEOVER_LIMITS,
  VOICEOVER_SPEAKERS,
  VOICEOVER_SPEAKER_NAMES,
  VoiceoverCheckpointSchema,
  aiVoiceoverJobKey,
  voiceoverAudioKey,
} from "./voiceover.js";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

const PAYLOAD = fixture("ai-voiceover-payload.v1.json");
const RESULT = fixture("ai-voiceover-result.v1.json");

const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VOICEOVER = "01JCDVC0000000000000000000";

/**
 * The field lists `apps/worker-ai/tests/test_voiceover_contracts.py` asserts
 * too, so a field added on one side and not the other fails a test on both.
 */
const PAYLOAD_FIELDS = [
  "clipId",
  "destination",
  "language",
  "model",
  "pace",
  "runId",
  "schemaVersion",
  "speaker",
  "text",
  "voiceoverId",
];
const RESULT_FIELDS = [
  "characters",
  "contentType",
  "durationMs",
  "key",
  "reused",
  "schemaVersion",
  "sizeBytes",
  "voiceoverId",
];
const CHECKPOINT_FIELDS = ["characters", "durationMs", "key", "sizeBytes"];

describe("ai.voiceover@1 (2026-10-01)", () => {
  it("parses the shared fixtures, the same ones the Python worker parses", () => {
    expect(AiVoiceoverPayloadSchema.parse(PAYLOAD).voiceoverId).toBe(VOICEOVER);
    expect(AiVoiceoverResultSchema.parse(RESULT).durationMs).toBe(3000);
  });

  it("names the same fields the worker's mirror names", () => {
    expect(Object.keys(AiVoiceoverPayloadSchema.shape).sort()).toEqual(PAYLOAD_FIELDS);
    expect(Object.keys(AiVoiceoverResultSchema.shape).sort()).toEqual(RESULT_FIELDS);
    expect(Object.keys(VoiceoverCheckpointSchema.shape).sort()).toEqual(CHECKPOINT_FIELDS);
  });

  it("refuses a field it does not know, on both sides of the queue", () => {
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, extra: 1 }).success).toBe(false);
    expect(AiVoiceoverResultSchema.safeParse({ ...RESULT, extra: 1 }).success).toBe(false);
  });

  it("writes only the voice-over's own key", () => {
    const own = voiceoverAudioKey({
      workspaceId: WS,
      sourceProjectId: PROJECT,
      runId: RUN,
      voiceoverId: VOICEOVER,
    });
    expect(VOICEOVER_KEY_PATTERN.test(own)).toBe(true);
    for (const key of [
      `ws/${WS}/p/${PROJECT}/media/source.mp4`,
      `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/voiceovers/${VOICEOVER}/../hook.wav`,
      `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/dubs/${VOICEOVER}/hi-IN/audio.wav`,
      `${own}.mp3`,
    ]) {
      expect(VOICEOVER_KEY_PATTERN.test(key), key).toBe(false);
      expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, destination: { key } }).success).toBe(
        false,
      );
    }
  });

  it("holds the text, the pace and the voice to their bounds", () => {
    const long = "a".repeat(VOICEOVER_LIMITS.maxTextChars + 1);
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, text: long }).success).toBe(false);
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, text: " " }).success).toBe(false);
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, pace: 2 }).success).toBe(false);
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, speaker: "meera" }).success).toBe(
      false,
    );
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, language: "or-IN" }).success).toBe(
      false,
    );
    expect(AiVoiceoverPayloadSchema.safeParse({ ...PAYLOAD, model: "bulbul:v1" }).success).toBe(
      false,
    );
  });

  it("names every language and voice for a person", () => {
    for (const code of VOICEOVER_LANGUAGES) {
      // eslint-disable-next-line security/detect-object-injection -- a closed enum
      expect(VOICEOVER_LANGUAGE_NAMES[code]).toMatch(/\w/);
    }
    for (const speaker of VOICEOVER_SPEAKERS) {
      // eslint-disable-next-line security/detect-object-injection -- a closed enum
      expect(VOICEOVER_SPEAKER_NAMES[speaker]).toMatch(/\w/);
    }
  });

  it("keys each attempt apart", () => {
    expect(aiVoiceoverJobKey(VOICEOVER, 1)).not.toBe(aiVoiceoverJobKey(VOICEOVER, 2));
  });
});
