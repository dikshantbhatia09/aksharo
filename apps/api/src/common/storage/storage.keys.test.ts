import { describe, expect, it } from "vitest";

import {
  DERIVED_ARTEFACTS,
  derivedKey,
  exportKey,
  extensionOf,
  fontKey,
  keyBelongsToWorkspace,
  mediaPrefix,
  normaliseExtension,
  rawKey,
  StorageKeyError,
  subtitleKey,
  thumbKey,
} from "./storage.keys.js";

const WS = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const MEDIA = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";
const EXPORT = "01JBZ0Q4T7R8N4H1V0J9K2M3P8";
const FONT = "01JBZ0Q4T7R8N4H1V0J9K2M3P9";

describe("CONTRACTS §6 key shapes", () => {
  it("builds the raw key exactly as the contract spells it", () => {
    expect(rawKey(WS, PROJECT, MEDIA, "mp4")).toBe(`ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`);
  });

  it("builds every derived artefact under the same prefix", () => {
    for (const artefact of DERIVED_ARTEFACTS) {
      expect(derivedKey(WS, PROJECT, MEDIA, artefact)).toBe(
        `${mediaPrefix(WS, PROJECT, MEDIA)}/${artefact}`,
      );
    }
    expect(thumbKey(WS, PROJECT, MEDIA, 3)).toBe(
      `ws/${WS}/p/${PROJECT}/media/${MEDIA}/thumb-3.jpg`,
    );
  });

  it("builds export and font keys", () => {
    expect(exportKey(WS, PROJECT, EXPORT, "MP4")).toBe(
      `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`,
    );
    expect(fontKey(WS, FONT, "woff2")).toBe(`ws/${WS}/fonts/${FONT}.woff2`);
  });

  it("files the imported-subtitle sidecar under the media prefix", () => {
    expect(subtitleKey(WS, PROJECT, MEDIA)).toBe(
      `${mediaPrefix(WS, PROJECT, MEDIA)}/subtitle.json`,
    );
  });

  it("agrees with the Python helper the AI worker reads keys with", () => {
    // `apps/worker-ai/worker_ai/storage.py` builds the same strings; the two are
    // only ever correct together, so the shape is asserted verbatim here.
    expect(mediaPrefix(WS, PROJECT, MEDIA)).toBe(`ws/${WS}/p/${PROJECT}/media/${MEDIA}`);
  });
});

describe("id validation (THREAT-MODEL T5)", () => {
  it.each([
    ["a traversal", "../../etc"],
    ["an empty id", ""],
    ["a Crockford-excluded letter", "01JBZ0Q4T7R8N4H1V0J9K2M3PI"],
    ["a lowercase ULID", "01jbz0q4t7r8n4h1v0j9k2m3p5"],
    ["a short id", "01JBZ0Q4T7"],
  ])("refuses %s in a workspace id", (_label, bad) => {
    expect(() => rawKey(bad, PROJECT, MEDIA, "mp4")).toThrow(StorageKeyError);
  });

  it("refuses a bad project id and a bad media id too", () => {
    expect(() => rawKey(WS, "../x", MEDIA, "mp4")).toThrow(StorageKeyError);
    expect(() => rawKey(WS, PROJECT, "nope", "mp4")).toThrow(StorageKeyError);
  });

  it("refuses a negative thumbnail index", () => {
    expect(() => thumbKey(WS, PROJECT, MEDIA, -1)).toThrow(StorageKeyError);
    expect(() => thumbKey(WS, PROJECT, MEDIA, 1.5)).toThrow(StorageKeyError);
  });

  it("refuses an artefact outside the contract's list", () => {
    expect(() =>
      derivedKey(WS, PROJECT, MEDIA, "secrets.env" as (typeof DERIVED_ARTEFACTS)[number]),
    ).toThrow(StorageKeyError);
  });

  it("refuses a font extension outside the contract's list", () => {
    expect(() => fontKey(WS, FONT, "exe" as "ttf")).toThrow(StorageKeyError);
  });
});

describe("normaliseExtension", () => {
  it("lowercases and drops leading dots", () => {
    expect(normaliseExtension(".MOV")).toBe("mov");
    expect(normaliseExtension("mp4")).toBe("mp4");
  });

  it.each(["", ".", "tar.gz", "m p4", "verylongextension", "../"])("refuses %j", (bad) => {
    expect(() => normaliseExtension(bad)).toThrow(StorageKeyError);
  });
});

describe("extensionOf", () => {
  it("reads the extension off a plain name", () => {
    expect(extensionOf("holiday.MP4")).toBe("mp4");
  });

  it("takes the last path segment, on either separator", () => {
    expect(extensionOf("C:\\Users\\me\\clip.mov")).toBe("mov");
    expect(extensionOf("/home/me/clip.mkv")).toBe("mkv");
  });

  it("is undefined when there is nothing usable", () => {
    expect(extensionOf("README")).toBeUndefined();
    expect(extensionOf(".hidden")).toBeUndefined();
    expect(extensionOf("trailing.")).toBeUndefined();
    expect(extensionOf("weird.na me")).toBeUndefined();
  });
});

describe("keyBelongsToWorkspace", () => {
  it("is true only inside the workspace's namespace", () => {
    expect(keyBelongsToWorkspace(rawKey(WS, PROJECT, MEDIA, "mp4"), WS)).toBe(true);
    expect(keyBelongsToWorkspace(rawKey(WS, PROJECT, MEDIA, "mp4"), PROJECT)).toBe(false);
  });
});
