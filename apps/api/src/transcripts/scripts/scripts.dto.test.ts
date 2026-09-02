import { describe, expect, it } from "vitest";

import {
  InternalScriptsWriteDto,
  TranslateRequestDto,
  TransliterateRequestDto,
} from "./scripts.dto.js";
import { MAX_TRANSLATE_TARGETS } from "./scripts.errors.js";

describe("TransliterateRequestDto", () => {
  it("accepts roman and native", () => {
    expect(() => TransliterateRequestDto.zodSchema.parse({ script: "roman" })).not.toThrow();
    expect(() => TransliterateRequestDto.zodSchema.parse({ script: "native" })).not.toThrow();
  });

  it("rejects anything else, including `translated` and `en`", () => {
    expect(() => TransliterateRequestDto.zodSchema.parse({ script: "translated" })).toThrow();
    expect(() => TransliterateRequestDto.zodSchema.parse({ script: "en" })).toThrow();
    expect(() => TransliterateRequestDto.zodSchema.parse({})).toThrow();
  });
});

describe("TranslateRequestDto", () => {
  it("accepts a list of BCP-47-ish targets and defaults mode to segment", () => {
    const parsed = TranslateRequestDto.zodSchema.parse({ targets: ["en", "hi-Latn"] });
    expect(parsed).toEqual({ targets: ["en", "hi-Latn"], mode: "segment" });
  });

  it("rejects an empty targets list", () => {
    expect(() => TranslateRequestDto.zodSchema.parse({ targets: [] })).toThrow();
  });

  it(`rejects more than ${String(MAX_TRANSLATE_TARGETS)} targets`, () => {
    const targets = Array.from({ length: MAX_TRANSLATE_TARGETS + 1 }, () => "en");
    expect(() => TranslateRequestDto.zodSchema.parse({ targets })).toThrow();
  });

  it("rejects a target that is not a BCP-47-ish tag", () => {
    expect(() => TranslateRequestDto.zodSchema.parse({ targets: ["not a tag!"] })).toThrow();
  });

  it("rejects a mode other than segment", () => {
    expect(() =>
      TranslateRequestDto.zodSchema.parse({ targets: ["en"], mode: "document" }),
    ).toThrow();
  });
});

describe("InternalScriptsWriteDto", () => {
  const valid = {
    jobId: "01JCJOB00000000000000000000",
    targetScript: "native",
    provider: "indicxlit-ruletable",
    words: [{ wid: "0:0", text: "तो" }],
  };

  it("accepts a well-formed write", () => {
    expect(() => InternalScriptsWriteDto.zodSchema.parse(valid)).not.toThrow();
  });

  it("rejects a malformed word id", () => {
    expect(() =>
      InternalScriptsWriteDto.zodSchema.parse({
        ...valid,
        words: [{ wid: "not-a-wid", text: "x" }],
      }),
    ).toThrow();
  });

  it("rejects an empty words list", () => {
    expect(() => InternalScriptsWriteDto.zodSchema.parse({ ...valid, words: [] })).toThrow();
  });

  it("rejects a targetScript outside roman/native", () => {
    expect(() =>
      InternalScriptsWriteDto.zodSchema.parse({ ...valid, targetScript: "translated" }),
    ).toThrow();
  });
});
