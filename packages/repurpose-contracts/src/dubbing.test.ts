import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AiDubPayloadSchema,
  AiDubResultSchema,
  CLIP_VIDEO_KEY_PATTERN,
  DUB_AUDIO_EXTENSIONS,
  DUB_FOLDER_PATTERN,
  DUB_KEY_PATTERN,
  DUB_LANGUAGES,
  DUB_LANGUAGE_NAMES,
  DUB_LIMITS,
  DubCheckpointSchema,
  DubRunPayloadSchema,
  MediaDubPayloadSchema,
  MediaDubResultSchema,
  aiDubCancelJobKey,
  aiDubJobKey,
  dubFolder,
  dubLanguageFolder,
  dubVideoKey,
  mediaDubJobKey,
  shapeSlug,
} from "./dubbing.js";
import { VIDEO_SHAPES } from "./formats.js";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

const PAYLOAD = fixture("ai-dub-payload.v1.json");
const CANCEL = fixture("ai-dub-cancel-payload.v1.json");
const RESULT = fixture("ai-dub-result.v1.json");
const CANCEL_RESULT = fixture("ai-dub-cancel-result.v1.json");
const MUX = fixture("media-dub-payload.v1.json");
const MUX_RESULT = fixture("media-dub-result.v1.json");

const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DUB = "01JCDVB0000000000000000000";
const FOLDER = `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/dubs/${DUB}`;

/**
 * The field lists `apps/worker-ai/tests/test_dub_contracts.py` asserts too, so a
 * field added on one side and not the other fails a test on both.
 */
const RUN_PAYLOAD_FIELDS = [
  "action",
  "clipId",
  "destinationPrefix",
  "dubId",
  "durationMs",
  "resumeVendorJobId",
  "runId",
  "schemaVersion",
  "source",
  "sourceLanguage",
  "speakers",
  "targetLanguages",
];
const RUN_RESULT_FIELDS = [
  "action",
  "dubId",
  "schemaVersion",
  "tracks",
  "vendorJobId",
  "vendorStatus",
];

describe("ai.dub@1 (2026-10-04)", () => {
  it("parses the shared fixtures, the same ones the Python worker parses", () => {
    const payload = AiDubPayloadSchema.parse(PAYLOAD);
    expect(payload.action).toBe("dub");
    expect(Object.keys(PAYLOAD).sort()).toEqual(RUN_PAYLOAD_FIELDS);
    expect(AiDubPayloadSchema.parse(CANCEL).action).toBe("cancel");
    const result = AiDubResultSchema.parse(RESULT);
    expect(Object.keys(RESULT).sort()).toEqual(RUN_RESULT_FIELDS);
    expect(result.action === "dub" && result.tracks.map((track) => track.status)).toEqual([
      "ready",
      "failed",
    ]);
    expect(AiDubResultSchema.parse(CANCEL_RESULT).action).toBe("cancel");
  });

  it("takes a first attempt, which has no vendor job to resume", () => {
    const { resumeVendorJobId: _resume, ...first } = PAYLOAD;
    expect(DubRunPayloadSchema.safeParse(first).success).toBe(true);
  });

  it("reads only the clip's clean video: never a captioned export, a face track or a traversal", () => {
    const bad = [
      `ws/${WS}/p/${PROJECT}/exports/01JCEXP0RT0000000000000000.mp4`,
      `ws/${WS}/p/${PROJECT}/media/01JCMED1A00000000000000000/faces.json`,
      `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/clips/../../x/master.mp4`,
      `/ws/${WS}/p/${PROJECT}/repurpose/${RUN}/clips/01ARZ3NDEKTSV4RRFFQ69G5FAW/master.mp4`,
      `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/clips/01ARZ3NDEKTSV4RRFFQ69G5FAW/master-2x3.mp4`,
    ];
    for (const key of bad) {
      const payload = { ...PAYLOAD, source: { key, contentType: "video/mp4" } };
      expect(DubRunPayloadSchema.safeParse(payload).success, key).toBe(false);
    }
  });

  it("refuses its own language, a language twice, zero speakers and an empty list", () => {
    expect(
      DubRunPayloadSchema.safeParse({ ...PAYLOAD, targetLanguages: ["en-IN", "hi-IN"] }).success,
    ).toBe(false);
    expect(
      DubRunPayloadSchema.safeParse({ ...PAYLOAD, targetLanguages: ["hi-IN", "hi-IN"] }).success,
    ).toBe(false);
    expect(DubRunPayloadSchema.safeParse({ ...PAYLOAD, speakers: 0 }).success).toBe(false);
    expect(DubRunPayloadSchema.safeParse({ ...PAYLOAD, speakers: 11 }).success).toBe(false);
    expect(DubRunPayloadSchema.safeParse({ ...PAYLOAD, targetLanguages: [] }).success).toBe(false);
    expect(DubRunPayloadSchema.safeParse({ ...PAYLOAD, targetLanguages: ["od-IN"] }).success).toBe(
      false,
    );
  });

  it("holds a vendor job id to the characters an id is made of", () => {
    for (const id of ["../x", "a b", "", "x".repeat(129), "id?x=1"]) {
      expect(DubRunPayloadSchema.safeParse({ ...PAYLOAD, resumeVendorJobId: id }).success, id).toBe(
        false,
      );
    }
  });

  it("holds every file of a result to the dub's own folder", () => {
    const tracks = (RESULT["tracks"] as Record<string, unknown>[]).map((track) => ({ ...track }));
    const ready = tracks[0] as Record<string, unknown>;
    ready["audio"] = {
      ...(ready["audio"] as Record<string, unknown>),
      key: `ws/${WS}/p/${PROJECT}/media/01JCMED1A00000000000000000/audio16k.wav`,
    };
    expect(AiDubResultSchema.safeParse({ ...RESULT, tracks }).success).toBe(false);
  });

  it("says a ready language carries both files", () => {
    const tracks = [{ language: "hi-IN", status: "ready" }];
    expect(AiDubResultSchema.safeParse({ ...RESULT, tracks }).success).toBe(false);
  });

  it("parses what a worker records before it starts the vendor's job", () => {
    const checkpoint = {
      vendorJobId: "5f0c2d6e-8a1b-4c3d-9e7f-0a1b2c3d4e5f",
      vendorPhase: "created",
    };
    expect(DubCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(DubCheckpointSchema.safeParse({ ...checkpoint, vendorPhase: "done" }).success).toBe(
      false,
    );
  });
});

describe("media.dub@1 (2026-10-04)", () => {
  it("parses the shared fixtures", () => {
    expect(MediaDubPayloadSchema.parse(MUX).shape).toBe("4:5");
    expect(MediaDubResultSchema.parse(MUX_RESULT).fit).toBe("trimmed");
  });

  it("keeps the clip's own sound only when it is asked to, and never louder than it was", () => {
    expect(MediaDubPayloadSchema.safeParse({ ...MUX, originalBedDb: -18 }).success).toBe(true);
    expect(MediaDubPayloadSchema.safeParse({ ...MUX, originalBedDb: 3 }).success).toBe(false);
  });

  it("writes only inside the dub's folder", () => {
    const destination = {
      bucket: "r2",
      key: `ws/${WS}/p/${PROJECT}/repurpose/${RUN}/clips/01ARZ3NDEKTSV4RRFFQ69G5FAW/master.mp4`,
    };
    expect(MediaDubPayloadSchema.safeParse({ ...MUX, destination }).success).toBe(false);
  });
});

describe("dub keys", () => {
  it("builds a dub's folder and its files as the patterns expect", () => {
    const folder = dubFolder({
      workspaceId: WS,
      sourceProjectId: PROJECT,
      runId: RUN,
      dubId: DUB,
    });
    expect(folder).toBe(FOLDER);
    expect(DUB_FOLDER_PATTERN.test(folder)).toBe(true);
    expect(dubVideoKey(folder, "ta-IN", "16:9")).toBe(`${FOLDER}/ta-IN/16x9.mp4`);
    expect(DUB_KEY_PATTERN.test(dubVideoKey(folder, "ta-IN", "16:9"))).toBe(true);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/or-IN/audio.wav`)).toBe(true);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/or-IN/captions.srt`)).toBe(true);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/or-IN/notes.txt`)).toBe(false);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/od-IN/audio.wav`)).toBe(false);
    expect(dubLanguageFolder(folder, "hi-IN")).toBe(`${FOLDER}/hi-IN/`);
    const video = MUX["video"] as { readonly key: string };
    expect(CLIP_VIDEO_KEY_PATTERN.test(video.key)).toBe(true);
  });

  it("spells out every language, audio type and shape the lists name, and nothing else", () => {
    for (const language of DUB_LANGUAGES) {
      for (const extension of DUB_AUDIO_EXTENSIONS) {
        expect(DUB_KEY_PATTERN.test(`${FOLDER}/${language}/audio.${extension}`)).toBe(true);
      }
      for (const shape of VIDEO_SHAPES) {
        expect(DUB_KEY_PATTERN.test(dubVideoKey(FOLDER, language, shape))).toBe(true);
      }
    }
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/hi-IN/audio.exe`)).toBe(false);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/hi-IN/2x3.mp4`)).toBe(false);
    expect(DUB_KEY_PATTERN.test(`${FOLDER}/ur-IN/captions.srt`)).toBe(false);
  });

  it("names one job per attempt, one cancel per vendor job, and one mux per language and shape", () => {
    expect(aiDubJobKey(DUB, 2)).toBe(`ai.dub:${DUB}:2`);
    expect(aiDubCancelJobKey(DUB, "abc")).toBe(`ai.dub.cancel:${DUB}:abc`);
    expect(mediaDubJobKey(DUB, "hi-IN", "9:16")).toBe(`media.dub:${DUB}:hi-IN:9x16`);
    expect(shapeSlug("1:1")).toBe("1x1");
  });

  it("names every language and leaves room for all but the clip's own", () => {
    expect(Object.keys(DUB_LANGUAGE_NAMES).sort()).toEqual([...DUB_LANGUAGES].sort());
    expect(DUB_LIMITS.maxLanguages).toBe(DUB_LANGUAGES.length - 1);
    expect(DUB_LANGUAGES).toContain("or-IN");
  });
});
