import { describe, expect, it } from "vitest";

import { easeInCubic, easeOutQuad } from "./animate/easing.js";
import { isRenderError, RenderError } from "./errors.js";
import { __testing } from "./fonts/registry.js";
import { PACKAGE_INFO } from "./package-info.js";

describe("RenderError", () => {
  it("carries a namespaced code and the details a caller needs", () => {
    const error = new RenderError("render/no-font", "no font", { family: "Inter" });
    expect(error.name).toBe("RenderError");
    expect(error.code).toBe("render/no-font");
    expect(error.details).toEqual({ family: "Inter" });
    expect(error.message).toBe("no font");
  });

  it("narrows a thrown value", () => {
    expect(isRenderError(new RenderError("render/invalid-input", "x"))).toBe(true);
    expect(isRenderError(new Error("x"))).toBe(false);
    expect(isRenderError("render/no-font")).toBe(false);
  });
});

describe("package identity", () => {
  it("reports itself as implemented now that A16 has landed", () => {
    expect(PACKAGE_INFO).toEqual({
      name: "@montaj/render-core",
      implementedBy: "A16",
      implemented: true,
    });
  });
});

describe("the remaining easings", () => {
  it("run from 0 to 1 and ease the right way round", () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
    expect(easeOutQuad(0.5)).toBeGreaterThan(0.5);
    expect(easeInCubic(0)).toBe(0);
    expect(easeInCubic(1)).toBe(1);
    expect(easeInCubic(0.5)).toBeLessThan(0.5);
  });
});

/**
 * A minimal font with a format-12 character map. The fixture fonts all use
 * format 4, so this is the only way to exercise the branch that reads a full
 * repertoire table — which is what an emoji or a Tamil Supplement face uses.
 */
function fontWithFormat12Cmap(groups: readonly [number, number][]): Uint8Array {
  const cmapLength = 16 + groups.length * 12;
  const bytes = new Uint8Array(12 + 16 + 4 + 8 + cmapLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); // sfnt version
  view.setUint16(4, 1); // one table
  const record = 12;
  for (const [index, character] of [..."cmap"].entries()) {
    view.setUint8(record + index, character.charCodeAt(0));
  }
  const cmapOffset = record + 16;
  view.setUint32(record + 8, cmapOffset);
  view.setUint32(record + 12, 4 + 8 + cmapLength);

  view.setUint16(cmapOffset, 0); // version
  view.setUint16(cmapOffset + 2, 1); // one subtable
  view.setUint16(cmapOffset + 4, 3); // platform: Windows
  view.setUint16(cmapOffset + 6, 10); // encoding: full repertoire
  const subtable = cmapOffset + 12;
  view.setUint32(cmapOffset + 8, subtable - cmapOffset);

  view.setUint16(subtable, 12); // format
  view.setUint32(subtable + 4, cmapLength); // length
  view.setUint32(subtable + 12, groups.length);
  for (const [index, [start, end]] of groups.entries()) {
    const group = subtable + 16 + index * 12;
    view.setUint32(group, start);
    view.setUint32(group + 4, end);
    view.setUint32(group + 8, 1);
  }
  return bytes;
}

describe("format-12 character maps", () => {
  it("reads a full-repertoire table", () => {
    const covered = __testing.readCharacterMap(fontWithFormat12Cmap([[0x41, 0x43]]));
    expect([...covered].sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x43]);
  });

  it("skips a group that claims an implausible span", () => {
    expect(__testing.readCharacterMap(fontWithFormat12Cmap([[0x0, 0x10_0000]])).size).toBe(0);
  });
});
