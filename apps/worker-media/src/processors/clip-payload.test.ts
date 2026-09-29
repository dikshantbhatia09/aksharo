import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLIP_PAYLOAD_FIELDS,
  assertKnownClipFields,
  readAudiogram,
  unknownClipFields,
} from "./clip-payload.js";
import { MediaJobError } from "../errors.js";

/**
 * The worker restates `media.clip@1` (it cannot import the contract), so the
 * restatement is held to the contract's own source and fixtures, the way
 * `queues.test.ts` holds the queue names to the API's.
 */
const CONTRACT = resolve(__dirname, "../../../../packages/repurpose-contracts");
const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixture name from this test's own literals
  return JSON.parse(readFileSync(resolve(CONTRACT, "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

function refusal(action: () => unknown): MediaJobError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaJobError);
    return error as MediaJobError;
  }
  throw new Error("expected a refusal");
}

describe("the restated media.clip payload", () => {
  it("knows exactly the fields the contract lists", () => {
    const source = readFileSync(resolve(CONTRACT, "src/jobs.ts"), "utf8");
    const start = source.indexOf("export const MEDIA_CLIP_PAYLOAD_FIELDS");
    const block = source.slice(start, source.indexOf("] as const", start));
    const fromContract = [...block.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    expect(fromContract.length).toBeGreaterThan(10);
    expect([...CLIP_PAYLOAD_FIELDS]).toEqual(fromContract);
  });

  it("accepts every documented payload, the audiogram among them", () => {
    for (const name of [
      "media-clip-payload.v1.json",
      "media-clip-payload-stacked.v1.json",
      "media-clip-payload-audiogram.v1.json",
    ]) {
      const payload = fixture(name);
      expect(unknownClipFields(payload), name).toEqual([]);
      expect(() => assertKnownClipFields(payload)).not.toThrow();
    }
    const audiogram = readAudiogram(
      fixture("media-clip-payload-audiogram.v1.json")["audiogram"],
      WS,
    );
    expect(audiogram).toEqual({
      background: "#141217",
      accent: "#f0508a",
      artwork: { key: `ws/${WS}/brand/01ARZ3NDEKTSV4RRFFQ69G5FC1.jpg`, format: "jpeg" },
    });
  });

  it("refuses a field it does not know, once and for good, naming it", () => {
    const payload = { ...fixture("media-clip-payload.v1.json"), sparkle: true, alpha: 1 };
    const error = refusal(() => {
      assertKnownClipFields(payload);
    });
    expect(error.code).toBe("worker/outdated");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("alpha, sparkle");
  });
});

describe("readAudiogram", () => {
  const valid = {
    background: "#141217",
    accent: "#f1ece6",
    artwork: { key: `ws/${WS}/brand/01ARZ3NDEKTSV4RRFFQ69G5FC1.png`, format: "png" },
  };

  it("is nothing when the payload asks for nothing", () => {
    expect(readAudiogram(undefined, WS)).toBeUndefined();
  });

  it("takes an audiogram without artwork", () => {
    expect(readAudiogram({ background: "#000000", accent: "#FFFFFF" }, WS)).toEqual({
      background: "#000000",
      accent: "#FFFFFF",
    });
  });

  it("refuses colours a filtergraph could read as more than a colour", () => {
    for (const colour of ["white", "#fff", "#12345G", "#000000:s=1x1", "0x000000", 7]) {
      const error = refusal(() => readAudiogram({ ...valid, background: colour }, WS));
      expect(error.reason).toBe("media/unsupported");
      expect(error.retryable).toBe(false);
      refusal(() => readAudiogram({ ...valid, accent: colour }, WS));
    }
  });

  it("refuses artwork outside this job's workspace, or that is not a plain key", () => {
    for (const key of [
      "ws/01ARZ3NDEKTSV4RRFFQ69G5FZZ/brand/x.png",
      `ws/${WS}/../01ARZ3NDEKTSV4RRFFQ69G5FZZ/brand/x.png`,
      `/ws/${WS}/brand/x.png`,
      `ws/${WS}\\brand\\x.png`,
      "https://example.test/x.png",
      "",
    ]) {
      refusal(() => readAudiogram({ ...valid, artwork: { ...valid.artwork, key } }, WS));
    }
  });

  it("refuses an artwork type it cannot draw, and fields it does not know", () => {
    refusal(() => readAudiogram({ ...valid, artwork: { ...valid.artwork, format: "gif" } }, WS));
    refusal(() => readAudiogram({ ...valid, artwork: { ...valid.artwork, width: 10 } }, WS));
    refusal(() => readAudiogram({ ...valid, style: "bars" }, WS));
    refusal(() => readAudiogram("audiogram", WS));
    refusal(() => readAudiogram({ ...valid, artwork: "cover.png" }, WS));
  });
});
