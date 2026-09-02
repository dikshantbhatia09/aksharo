import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HDR_TRANSFERS, PROBE_RESULT_FIELDS, ProbeResultSchema } from "./probe-result.js";

/**
 * The probe result is a contract with a worker in another package, and neither
 * side can import the other. So the worker's copy is parsed and pinned here: a
 * field renamed over there is not a compile error here, it is a measurement this
 * schema silently drops.
 */
const WORKER_CONTRACT = resolve(
  __dirname,
  "../../../worker-media/src/probe-result.ts",
);

function minimal(): Record<string, unknown> {
  return {
    mediaId: "01JCMED1A00000000000000000",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationMs: 10_000,
    hasVideo: true,
    hasAudio: true,
    probedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("the worker's copy of the contract", () => {
  it("names exactly the same fields, in the same order", () => {
    const source = readFileSync(WORKER_CONTRACT, "utf8");
    const block = source.slice(
      source.indexOf("export const PROBE_RESULT_FIELDS"),
      source.indexOf("] as const", source.indexOf("export const PROBE_RESULT_FIELDS")),
    );
    const fromWorker = [...block.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    expect(fromWorker).toEqual([...PROBE_RESULT_FIELDS]);
  });

  it("agrees on which transfer curves mean HDR", () => {
    const source = readFileSync(WORKER_CONTRACT, "utf8");
    const block = source.slice(
      source.indexOf("export const HDR_TRANSFERS"),
      source.indexOf("] as const", source.indexOf("export const HDR_TRANSFERS")),
    );
    expect([...block.matchAll(/"([\w-]+)"/g)].map((match) => match[1])).toEqual([...HDR_TRANSFERS]);
    // bt2020-10 is a wide gamut on an SDR curve; tone-mapping it would wash out a
    // perfectly ordinary picture.
    expect(HDR_TRANSFERS).not.toContain("bt2020-10");
  });

  it("covers every field the schema parses", () => {
    const parsed = ProbeResultSchema.parse(minimal());
    for (const field of PROBE_RESULT_FIELDS) expect(parsed).toHaveProperty(field);
  });
});

describe("ProbeResultSchema", () => {
  it("fills the optional halves with nulls rather than leaving them absent", () => {
    const parsed = ProbeResultSchema.parse(minimal());
    expect(parsed.video).toBeNull();
    expect(parsed.audio).toBeNull();
    expect(parsed.mime).toBeNull();
    expect(parsed.sizeBytes).toBeNull();
  });

  it("refuses a durationMs that is a string, because a plan check reads it", () => {
    expect(ProbeResultSchema.safeParse({ ...minimal(), durationMs: "10000" }).success).toBe(false);
    expect(ProbeResultSchema.safeParse({ ...minimal(), durationMs: -1 }).success).toBe(false);
  });

  it("accepts a field it has never heard of, so a rolled-ahead worker still lands", () => {
    expect(ProbeResultSchema.safeParse({ ...minimal(), bitrateBps: 8_000_000 }).success).toBe(true);
  });

  it("accepts only the four quarter-turn rotations", () => {
    const video = {
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: 30,
      hdr: false,
    };
    for (const rotation of [0, 90, 180, 270]) {
      expect(ProbeResultSchema.safeParse({ ...minimal(), video: { ...video, rotation } }).success).toBe(
        true,
      );
    }
    expect(
      ProbeResultSchema.safeParse({ ...minimal(), video: { ...video, rotation: 45 } }).success,
    ).toBe(false);
  });

  it("keeps the loudness and silence stats a probe measured", () => {
    const parsed = ProbeResultSchema.parse({
      ...minimal(),
      audio: {
        codec: "aac",
        channels: 2,
        sampleRate: 48_000,
        loudnessLufs: -18.4,
        loudnessRangeLu: 6.2,
        truePeakDbfs: -1.5,
        silenceRatio: 0.12,
        silences: [{ startMs: 0, endMs: 1_200 }],
      },
    });
    expect(parsed.audio?.loudnessLufs).toBe(-18.4);
    expect(parsed.audio?.silences).toHaveLength(1);
  });

  it("defaults the loudness fields to null when the pass did not run", () => {
    // Zero LUFS is deafening; "we did not measure" has to be distinguishable.
    const parsed = ProbeResultSchema.parse({
      ...minimal(),
      audio: { codec: "aac", channels: 1, sampleRate: 16_000 },
    });
    expect(parsed.audio?.loudnessLufs).toBeNull();
    expect(parsed.audio?.silenceRatio).toBeNull();
    expect(parsed.audio?.silences).toEqual([]);
  });

  it("refuses a silence ratio outside 0–1", () => {
    const audio = { codec: "aac", channels: 1, sampleRate: 16_000, silenceRatio: 1.5 };
    expect(ProbeResultSchema.safeParse({ ...minimal(), audio }).success).toBe(false);
  });
});
