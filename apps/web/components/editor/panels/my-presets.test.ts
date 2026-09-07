import { beforeEach, describe, expect, it } from "vitest";

import { STYLE_DOC_VERSION } from "@montaj/caption-styles";

import {
  buildPresetDoc,
  deleteMyPreset,
  loadMyPresets,
  myPresetsStorageKey,
  saveMyPreset,
} from "./my-presets";
import { SYSTEM_STYLE_MAP } from "./system-styles";

const BASE = SYSTEM_STYLE_MAP.get("punch-pop");
if (BASE === undefined) throw new Error("fixture missing: punch-pop");

beforeEach(() => {
  window.localStorage.clear();
});

describe("buildPresetDoc", () => {
  it("serialises the current style into a standalone, complete StyleDoc", () => {
    const result = buildPresetDoc("My look", BASE);
    expect(result.ok).toBe(true);
    expect(result.doc?.name).toBe("My look");
    expect(result.doc?.id).toMatch(/^my-my-look-[a-z0-9]+$/);
    expect(result.doc?.id).not.toBe(BASE.id);
    expect(result.doc?.version).toBe(STYLE_DOC_VERSION);
    // Everything else about the look carries over untouched.
    expect(result.doc?.typography).toEqual(BASE.typography);
    expect(result.doc?.colors).toEqual(BASE.colors);
    expect(result.doc?.emphasisPresets).toEqual(BASE.emphasisPresets);
  });

  it("resets the parity flags to the schema's own pre-gate defaults", () => {
    const withParity = { ...BASE, assRenderable: true, assExportable: true, parityScore: 0.99 };
    const result = buildPresetDoc("My look", withParity);
    expect(result.doc?.assRenderable).toBe(false);
    expect(result.doc?.assExportable).toBe(false);
    expect(result.doc?.requiresLayoutMetrics).toBe(true);
    expect(result.doc?.parityScore).toBeUndefined();
  });

  it("gives two presets saved from the same style two different ids", () => {
    const a = buildPresetDoc("My look", BASE);
    const b = buildPresetDoc("My look", BASE);
    expect(a.doc?.id).not.toBe(b.doc?.id);
  });

  it("refuses a name too short to find again", () => {
    expect(buildPresetDoc(" a ", BASE)).toMatchObject({ ok: false });
    expect(buildPresetDoc("   ", BASE)).toMatchObject({ ok: false });
  });

  it("respects D64 — no person, creator or brand name (acceptance criterion 6)", () => {
    const result = buildPresetDoc("Hormozi Pop", BASE);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/D64/);
  });
});

describe("localStorage round-trip", () => {
  it("starts empty for a project with nothing saved", () => {
    expect(loadMyPresets("proj-1")).toEqual([]);
  });

  it("saves, lists and reloads a preset for its project", () => {
    const built = buildPresetDoc("My look", BASE);
    if (!built.ok || built.doc === undefined) throw new Error("expected a valid preset");
    saveMyPreset("proj-1", built.doc);
    expect(loadMyPresets("proj-1")).toEqual([built.doc]);
  });

  it("scopes presets per project — a second project starts empty", () => {
    const built = buildPresetDoc("My look", BASE);
    if (!built.ok || built.doc === undefined) throw new Error("expected a valid preset");
    saveMyPreset("proj-1", built.doc);
    expect(loadMyPresets("proj-2")).toEqual([]);
  });

  it("appends rather than replacing on a second save", () => {
    const first = buildPresetDoc("Look one", BASE);
    const second = buildPresetDoc("Look two", BASE);
    if (!first.ok || !second.ok || first.doc === undefined || second.doc === undefined) {
      throw new Error("expected two valid presets");
    }
    saveMyPreset("proj-1", first.doc);
    saveMyPreset("proj-1", second.doc);
    expect(loadMyPresets("proj-1").map((doc) => doc.name)).toEqual(["Look one", "Look two"]);
  });

  it("deletes one preset by id, leaving the rest", () => {
    const first = buildPresetDoc("Look one", BASE);
    const second = buildPresetDoc("Look two", BASE);
    if (!first.ok || !second.ok || first.doc === undefined || second.doc === undefined) {
      throw new Error("expected two valid presets");
    }
    saveMyPreset("proj-1", first.doc);
    saveMyPreset("proj-1", second.doc);
    deleteMyPreset("proj-1", first.doc.id);
    expect(loadMyPresets("proj-1").map((doc) => doc.name)).toEqual(["Look two"]);
  });

  it("drops a corrupt stored entry instead of throwing", () => {
    window.localStorage.setItem(
      myPresetsStorageKey("proj-1"),
      JSON.stringify([{ not: "a style" }]),
    );
    expect(loadMyPresets("proj-1")).toEqual([]);
  });

  it("survives unparsable JSON in storage", () => {
    window.localStorage.setItem(myPresetsStorageKey("proj-1"), "{not json");
    expect(loadMyPresets("proj-1")).toEqual([]);
  });
});
