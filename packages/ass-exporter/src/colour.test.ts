import { describe, expect, it } from "vitest";

import { parseHexColour, toAssAlpha, toAssColour, toAssColourNoAlpha } from "./colour.js";

describe("parseHexColour", () => {
  it("parses #RRGGBB as opaque", () => {
    expect(parseHexColour("#ff0080")).toEqual({ r: 255, g: 0, b: 128, a: 255 });
  });

  it("parses #RRGGBBAA", () => {
    expect(parseHexColour("#ff008040")).toEqual({ r: 255, g: 0, b: 128, a: 0x40 });
  });

  it("throws on garbage", () => {
    expect(() => parseHexColour("blue")).toThrow();
  });
});

describe("toAssColour", () => {
  it("swaps to BGR and inverts alpha for opaque white", () => {
    // opaque (StyleDoc alpha=255) -> ASS alpha 00
    expect(toAssColour("#ffffff")).toBe("&H00FFFFFF&");
  });

  it("inverts a half-transparent alpha", () => {
    // StyleDoc alpha 0x66 (102) -> ASS alpha 255-102=153=0x99
    expect(toAssColour("#ffffff66")).toBe("&H99FFFFFF&");
  });

  it("fully transparent StyleDoc alpha becomes ASS FF", () => {
    expect(toAssColour("#00000000")).toBe("&HFF000000&");
  });

  it("reorders RGB to BGR", () => {
    expect(toAssColour("#112233")).toBe("&H00332211&");
  });
});

describe("toAssColourNoAlpha", () => {
  it("drops the alpha byte", () => {
    expect(toAssColourNoAlpha("#11223344")).toBe("&H332211&");
  });
});

describe("toAssAlpha", () => {
  it("is the inverted alpha byte alone", () => {
    expect(toAssAlpha("#ffffffff")).toBe("&H00&");
    expect(toAssAlpha("#ffffff00")).toBe("&HFF&");
  });
});
