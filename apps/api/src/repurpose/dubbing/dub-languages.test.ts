import { describe, expect, it } from "vitest";

import { DUB_LANGUAGES } from "@montaj/repurpose-contracts";

import {
  DUB_LANGUAGE_OPTIONS,
  isDubLanguage,
  productLanguageOf,
  vendorLanguageOf,
} from "./dub-languages.js";

describe("vendorLanguageOf (2026-10-04)", () => {
  it("maps the product's tags onto the vendor's codes", () => {
    expect(vendorLanguageOf("en")).toBe("en-IN");
    expect(vendorLanguageOf("en-US")).toBe("en-IN");
    expect(vendorLanguageOf("hi")).toBe("hi-IN");
    expect(vendorLanguageOf("TA")).toBe("ta-IN");
    expect(vendorLanguageOf("bn-IN")).toBe("bn-IN");
  });

  it("treats Hinglish, however it is spelled, as Hindi", () => {
    for (const tag of ["hi-Latn", "hinglish", "hi-en", "hi_en", "en-hi"]) {
      expect(vendorLanguageOf(tag), tag).toBe("hi-IN");
    }
  });

  it("spells Odia the way dubbing does, whichever way it arrives", () => {
    expect(vendorLanguageOf("or")).toBe("or-IN");
    expect(vendorLanguageOf("od")).toBe("or-IN");
  });

  it("answers null for what it cannot dub from", () => {
    for (const tag of ["", "auto", "ur", "fr", "und", null, undefined]) {
      expect(vendorLanguageOf(tag), String(tag)).toBeNull();
    }
  });

  it("writes a dubbed project in the product's own tag", () => {
    expect(productLanguageOf("hi-IN")).toBe("hi");
    expect(productLanguageOf("or-IN")).toBe("or");
  });

  it("offers every vendor language, named", () => {
    expect(DUB_LANGUAGE_OPTIONS.map((option) => option.code)).toEqual([...DUB_LANGUAGES]);
    expect(DUB_LANGUAGE_OPTIONS.find((option) => option.code === "ta-IN")?.name).toBe("Tamil");
    expect(isDubLanguage("te-IN")).toBe(true);
    expect(isDubLanguage("od-IN")).toBe(false);
  });
});
