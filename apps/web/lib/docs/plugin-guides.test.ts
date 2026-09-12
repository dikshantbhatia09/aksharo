import { describe, expect, it } from "vitest";

import { getPluginGuide, loadPluginGuides } from "./plugin-guides";

describe("loadPluginGuides", () => {
  it("returns an array of guides safely", () => {
    const guides = loadPluginGuides();
    expect(Array.isArray(guides)).toBe(true);
  });

  it("is deterministic across repeated calls (cached)", () => {
    expect(loadPluginGuides()).toEqual(loadPluginGuides());
  });

  it("every guide has a non-empty title and body if any exist", () => {
    for (const guide of loadPluginGuides()) {
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.body.length).toBeGreaterThan(50);
    }
  });

  it("every guide's sourcePath uses forward slashes and points at its README if any exist", () => {
    for (const guide of loadPluginGuides()) {
      expect(guide.sourcePath).toMatch(/^plugins\/[a-z-]+\/README\.md$/);
    }
  });
});

describe("getPluginGuide", () => {
  it("returns undefined for an unknown slug", () => {
    expect(getPluginGuide("not-a-real-plugin")).toBeUndefined();
  });
});
