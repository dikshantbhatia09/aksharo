import { describe, expect, it } from "vitest";

import { getPluginGuide, loadPluginGuides } from "./plugin-guides";

describe("loadPluginGuides", () => {
  it("loads all four plugin READMEs", () => {
    const guides = loadPluginGuides();
    expect(guides.map((g) => g.slug).sort()).toEqual(
      ["after-effects", "premiere", "resolve", "resolve-panel"].sort(),
    );
  });

  it("is deterministic across repeated calls (cached)", () => {
    expect(loadPluginGuides()).toEqual(loadPluginGuides());
  });

  it("every guide has a non-empty title and body", () => {
    for (const guide of loadPluginGuides()) {
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.body.length).toBeGreaterThan(50);
    }
  });

  it("every guide's sourcePath uses forward slashes and points at its README", () => {
    for (const guide of loadPluginGuides()) {
      expect(guide.sourcePath).toMatch(/^plugins\/[a-z-]+\/README\.md$/);
    }
  });
});

describe("getPluginGuide", () => {
  it("finds a known slug", () => {
    expect(getPluginGuide("premiere")).toBeDefined();
  });

  it("returns undefined for an unknown slug", () => {
    expect(getPluginGuide("not-a-real-plugin")).toBeUndefined();
  });
});
