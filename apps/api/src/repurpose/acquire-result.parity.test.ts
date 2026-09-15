import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MediaAcquireResultSchema, REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

// Vitest runs with `apps/api` as cwd.
const ACQUIRE_SOURCE = resolve(process.cwd(), "..", "worker-media/src/processors/acquire.ts");

/**
 * `media.acquire`'s result, on both sides of the wire.
 *
 * The media worker does not import `@montaj/repurpose-contracts` — it builds the
 * result object by hand — so nothing connected the two until this test. They had
 * already drifted twice: the worker omitted `schemaVersion` entirely and sent a
 * `probeToolVersion` the strict schema did not allow, either of which makes every
 * completion unparseable at the API and leaves the media row stuck at `pending`
 * while the job retries to exhaustion. Nothing in either package's own suite
 * noticed, because each was internally consistent.
 *
 * So this reads the worker's source the way `queue-names.test.ts` reads its queue
 * list: a field added on one side fails on the other rather than being dropped in
 * transit.
 */
function workerResultKeys(): string[] {
  const source = readFileSync(ACQUIRE_SOURCE, "utf8");
  const start = source.indexOf("      result: {");
  if (start < 0) throw new Error("could not find the result object in acquire.ts");
  const block = source.slice(start, source.indexOf("\n      },", start));
  // Top-level keys of that object literal are indented by eight spaces; nested
  // ones (`sourceMetadata`) are deeper and are deliberately not collected here.
  return [...block.matchAll(/^ {8}(\w+)[,:]/gm)].map((match) => match[1] as string);
}

function workerSchemaVersion(): number {
  const source = readFileSync(ACQUIRE_SOURCE, "utf8");
  const match = /const RESULT_SCHEMA_VERSION = (\d+);/.exec(source);
  if (match === null) throw new Error("could not find RESULT_SCHEMA_VERSION in acquire.ts");
  return Number(match[1]);
}

describe("media.acquire result parity", () => {
  it("sends exactly the fields the contract accepts, and no others", () => {
    const contractKeys = Object.keys(MediaAcquireResultSchema.shape).sort();
    expect(workerResultKeys().sort()).toEqual(contractKeys);
  });

  it("stamps the schema version the contract pins", () => {
    expect(workerSchemaVersion()).toBe(REPURPOSE_SCHEMA_VERSION);
  });

  it("parses a result built the way the worker builds one", () => {
    // The shapes above prove the field NAMES line up; this proves the values do.
    const parsed = MediaAcquireResultSchema.safeParse({
      schemaVersion: workerSchemaVersion(),
      mediaId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
      bucket: "s3",
      key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/p/01ARZ3NDEKTSV4RRFFQ69G5FAX/media/m/raw.mp4",
      filename: "source.mp4",
      mime: "video/mp4",
      sizeBytes: 148_372_910,
      checksum: "0".repeat(64),
      sourceMetadata: {
        provider: "youtube",
        sourceId: "youtube:dQw4w9WgXcQ",
        title: "Episode 12",
        channel: "Example Channel",
        durationMs: 1_140_000,
      },
      toolVersion: "yt-dlp 2026.08.19",
      probeToolVersion: "ffprobe version 9.0",
      deduplicated: false,
    });
    expect(parsed.success).toBe(true);
  });
});
