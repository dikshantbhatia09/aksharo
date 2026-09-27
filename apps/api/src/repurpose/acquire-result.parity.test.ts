import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MediaAcquirePayloadSchema,
  MediaAcquireResultSchema,
  REPURPOSE_SCHEMA_VERSION,
} from "@montaj/repurpose-contracts";

// Vitest runs with `apps/api` as cwd.
const ACQUIRE_SOURCE = resolve(process.cwd(), "..", "worker-media/src/processors/acquire.ts");
const YT_DLP_SOURCE = resolve(process.cwd(), "..", "worker-media/src/yt-dlp.ts");

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
  const always = [...block.matchAll(/^ {8}(\w+)[,:]/gm)].map((match) => match[1] as string);
  // An optional field goes out as a conditional spread,
  // `...(x === null ? {} : { key: value })`, so a result without it has no key.
  const optional = [...block.matchAll(/^ {8}\.\.\.\(.*\? \{\} : \{ (\w+)[:, }]/gm)].map(
    (match) => match[1] as string,
  );
  return [...always, ...optional];
}

const readWorker = (which: "acquire" | "yt-dlp"): string =>
  which === "acquire" ? readFileSync(ACQUIRE_SOURCE, "utf8") : readFileSync(YT_DLP_SOURCE, "utf8");

/**
 * The keys a function's returned object or an interface in a worker source
 * spells out: the lines at exactly `indent` spaces between `marker` and the
 * next closing brace at the margin. Deeper lines (a nested object) are not
 * collected.
 */
function declaredKeys(source: string, marker: string, indent: number): string[] {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`could not find ${marker}`);
  const margin = " ".repeat(indent);
  return source
    .slice(start, source.indexOf("\n}", start))
    .split(/\r?\n/)
    .filter((line) => line.startsWith(margin) && !line.startsWith(`${margin} `))
    .map((line) => /^\s*(?:readonly )?(\w+)\??:/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

const contractSection = MediaAcquireResultSchema.shape.section.unwrap();
const contractWindow = MediaAcquirePayloadSchema.shape.window.unwrap();

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

  it("sends a section with exactly the contract's fields", () => {
    // `sectionResult` in acquire.ts builds it field by field.
    expect(declaredKeys(readWorker("acquire"), "function sectionResult", 4).sort()).toEqual(
      Object.keys(contractSection.shape).sort(),
    );
    const parsed = MediaAcquireResultSchema.safeParse({
      schemaVersion: workerSchemaVersion(),
      mediaId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
      bucket: "s3",
      key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/p/01ARZ3NDEKTSV4RRFFQ69G5FAX/media/m/raw.mp4",
      filename: "source.mp4",
      mime: "video/mp4",
      sizeBytes: 104_000_000,
      checksum: "0".repeat(64),
      sourceMetadata: {
        provider: "Youtube",
        sourceId: "aDpIra7NFuE",
        title: "A long podcast",
        channel: "Example Channel",
        durationMs: 1_200_412,
      },
      // Twenty minutes around the most-replayed moment of a 34:37 video.
      section: {
        startMs: 730_000,
        endMs: 1_930_000,
        sourceDurationMs: 2_077_000,
        policy: "most_replayed",
      },
      toolVersion: "yt-dlp 2026.08.19",
      probeToolVersion: "ffprobe version 9.0",
      deduplicated: false,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("media.acquire payload parity", () => {
  it("reads every field the contract sends, the window included", () => {
    // `AcquirePayload` in acquire.ts. `schemaVersion` is the envelope's
    // concern; the worker does not read it.
    const contract = Object.keys(MediaAcquirePayloadSchema.shape).filter(
      (key) => key !== "schemaVersion",
    );
    expect(
      declaredKeys(readWorker("acquire"), "export interface AcquirePayload", 2).sort(),
    ).toEqual(contract.sort());
  });

  it("knows the window's fields and every one of its policies", () => {
    expect(declaredKeys(readWorker("yt-dlp"), "export interface AcquireWindow", 2).sort()).toEqual(
      Object.keys(contractWindow.shape).sort(),
    );
    const source = readFileSync(ACQUIRE_SOURCE, "utf8");
    const policies = /const WINDOW_POLICIES[^=]*= \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...policies.matchAll(/"(\w+)"/g)].map((match) => match[1]).sort()).toEqual(
      [...contractWindow.shape.policy.options].sort(),
    );
  });
});
