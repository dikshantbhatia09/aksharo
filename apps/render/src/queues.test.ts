import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import {
  bullJobId,
  isJobEnvelope,
  RENDER_QUEUES,
  RENDER_SUBTITLE_QUEUE,
  RENDER_VIDEO_QUEUE,
  RenderProjectionSchema,
  RenderSubtitlePayloadSchema,
  RenderVideoPayloadSchema,
} from "./queues.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const API_QUEUE_NAMES = join(
  REPO_ROOT,
  "apps",
  "api",
  "src",
  "jobs",
  "contracts",
  "queue-names.ts",
);

describe("render queue contract (CONTRACTS §3)", () => {
  it("uses the frozen queue names", () => {
    expect(RENDER_VIDEO_QUEUE).toBe("render.video");
    expect(RENDER_SUBTITLE_QUEUE).toBe("render.subtitle");
    expect(RENDER_QUEUES).toEqual(["render.video", "render.subtitle"]);
  });

  it("does not drift from the API's canonical list", () => {
    // A typo is not a compile error anywhere — it is a queue nothing ever reads.
    const source = readFileSync(API_QUEUE_NAMES, "utf8");
    for (const name of RENDER_QUEUES) {
      expect(source).toContain(`"${name}"`);
    }
  });

  it("builds a BullMQ id without a colon in it", () => {
    expect(bullJobId("job", "attempt")).toBe("job-attempt");
    expect(bullJobId("job", "attempt")).not.toContain(":");
  });
});

describe("isJobEnvelope", () => {
  const envelope = {
    jobId: "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
    attemptId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
    workspaceId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
    priority: 5,
    jobKey: "render.video:01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" },
  };

  it("accepts a well-formed envelope", () => {
    expect(isJobEnvelope(envelope)).toBe(true);
  });

  it("accepts one with a projectId, and one without", () => {
    expect(isJobEnvelope({ ...envelope, projectId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VD" })).toBe(true);
  });

  it("rejects a projectId of null, which is what the Python worker also rejects", () => {
    expect(isJobEnvelope({ ...envelope, projectId: null })).toBe(false);
  });

  it("rejects a job whose data is not the contract envelope", () => {
    expect(isJobEnvelope({ exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" })).toBe(false);
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope({ ...envelope, priority: -1 })).toBe(false);
  });
});

describe("the payload schemas", () => {
  const projection = {
    canvas: { width: 1080, height: 1920 },
    segments: [
      {
        id: "seg-1",
        seq: "V",
        startMs: 0,
        endMs: 2_000,
        startWordId: "0:0",
        endWordId: "0:2",
      },
    ],
    words: [
      { wid: "0:0", s: 0, e: 500, t: "Bhai" },
      { wid: "0:1", s: 500, e: 1_000, t: "aaj" },
      { wid: "0:2", s: 1_000, e: 2_000, t: "video" },
    ],
  };

  it("parses a projection", () => {
    expect(RenderProjectionSchema.parse(projection).segments).toHaveLength(1);
  });

  it("defaults the render path to skia and the script to roman", () => {
    const parsed = RenderVideoPayloadSchema.parse({
      manifest: signedFixtureManifest("secret"),
      projection,
      styles: { "punch-pop": {} },
    });
    expect(parsed.path).toBe("skia");
    expect(parsed.script).toBe("roman");
    expect(parsed.dropFillers).toBe(false);
  });

  it("refuses a payload with no manifest", () => {
    expect(RenderVideoPayloadSchema.safeParse({ projection, styles: {} }).success).toBe(false);
  });

  it("parses a subtitle payload", () => {
    const parsed = RenderSubtitlePayloadSchema.parse({
      manifest: signedFixtureManifest("secret"),
      projection,
    });
    expect(parsed.projection.words).toHaveLength(3);
  });
});
