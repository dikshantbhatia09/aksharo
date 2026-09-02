import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DERIVED_ARTEFACTS,
  StorageKeyError,
  allDerivedKeys,
  derivedKey,
  mediaPrefix,
  thumbKey,
} from "./storage-keys.js";

/**
 * The third copy of the CONTRACTS §6 keys, checked against the API's, which is
 * the one the studio and the retention sweep read.
 */
const API_KEYS = resolve(__dirname, "../../api/src/common/storage/storage.keys.ts");

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const PREFIX = `ws/${WS}/p/${PROJECT}/media/${MEDIA}`;

describe("mediaPrefix", () => {
  it("builds the CONTRACTS §6 prefix both stores share", () => {
    expect(mediaPrefix(WS, PROJECT, MEDIA)).toBe(PREFIX);
  });

  it("refuses an id that is not a ULID, because a key is a path (T5)", () => {
    // `../` in an id would be a cross-tenant write; the API refuses the resulting
    // patch too, but the worker must not have built it in the first place.
    expect(() => mediaPrefix("../etc", PROJECT, MEDIA)).toThrow(StorageKeyError);
    expect(() => mediaPrefix(WS, "", MEDIA)).toThrow(StorageKeyError);
    expect(() => mediaPrefix(WS, PROJECT, "01jcmedia00000000000000000")).toThrow(StorageKeyError);
    // I, L, O and U are not in Crockford base32.
    expect(() => mediaPrefix(WS, PROJECT, "01JCMEDIAI0000000000000000")).toThrow(StorageKeyError);
  });
});

describe("derivedKey", () => {
  it("names exactly the four CONTRACTS §6 artefacts", () => {
    expect([...DERIVED_ARTEFACTS]).toEqual([
      "audio16k.wav",
      "audio48k.wav",
      "proxy540.mp4",
      "waveform.json",
    ]);
    expect(derivedKey(PREFIX, "proxy540.mp4")).toBe(`${PREFIX}/proxy540.mp4`);
    expect(derivedKey(PREFIX, "audio16k.wav")).toBe(`${PREFIX}/audio16k.wav`);
  });

  it("matches the API's artefact list, name for name", () => {
    const source = readFileSync(API_KEYS, "utf8");
    const block = source.slice(
      source.indexOf("export const DERIVED_ARTEFACTS"),
      source.indexOf("] as const", source.indexOf("export const DERIVED_ARTEFACTS")),
    );
    const fromApi = [...block.matchAll(/"([\w.]+)"/g)].map((match) => match[1]);
    expect(fromApi).toEqual([...DERIVED_ARTEFACTS]);
  });

  it("refuses an artefact CONTRACTS §6 does not enumerate", () => {
    // `poster.jpg` is the one the A07 brief asked for and CONTRACTS §6 does not
    // list; `thumb-0.jpg` is the poster, and the key set stays frozen.
    expect(() => derivedKey(PREFIX, "poster.jpg" as never)).toThrow(StorageKeyError);
  });
});

describe("thumbKey", () => {
  it("numbers from zero", () => {
    expect(thumbKey(PREFIX, 0)).toBe(`${PREFIX}/thumb-0.jpg`);
    expect(thumbKey(PREFIX, 9)).toBe(`${PREFIX}/thumb-9.jpg`);
  });

  it("refuses an index that is not a non-negative integer", () => {
    expect(() => thumbKey(PREFIX, -1)).toThrow(StorageKeyError);
    expect(() => thumbKey(PREFIX, 1.5)).toThrow(StorageKeyError);
  });
});

describe("allDerivedKeys", () => {
  it("lists everything one asset can have", () => {
    const keys = allDerivedKeys(PREFIX, 10);
    expect(keys).toHaveLength(14);
    expect(keys.every((key) => key.startsWith(`${PREFIX}/`))).toBe(true);
    expect(keys).toContain(`${PREFIX}/thumb-9.jpg`);
  });

  it("lists only the four artefacts for an audio-only asset", () => {
    expect(allDerivedKeys(PREFIX, 0)).toHaveLength(4);
  });
});
