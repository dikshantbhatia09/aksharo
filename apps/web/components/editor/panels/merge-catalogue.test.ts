import { describe, expect, it } from "vitest";

import { mergeCatalogue } from "./merge-catalogue";
import { SYSTEM_STYLE_MAP } from "./system-styles";

describe("mergeCatalogue", () => {
  it("returns the base map itself when there is nothing to add", () => {
    expect(mergeCatalogue(SYSTEM_STYLE_MAP, undefined)).toBe(SYSTEM_STYLE_MAP);
    expect(mergeCatalogue(SYSTEM_STYLE_MAP, {})).toBe(SYSTEM_STYLE_MAP);
    expect(mergeCatalogue(SYSTEM_STYLE_MAP, { bad: null, worse: "x", list: [] })).toBe(
      SYSTEM_STYLE_MAP,
    );
  });

  it("adds each look under the ref the document uses, never mutating the base", () => {
    const merged = mergeCatalogue(SYSTEM_STYLE_MAP, { "my-look": { id: "other", name: "Mine" } });
    expect(merged.get("my-look")).toMatchObject({ id: "my-look", name: "Mine" });
    expect(merged.size).toBe(SYSTEM_STYLE_MAP.size + 1);
    expect(SYSTEM_STYLE_MAP.has("my-look")).toBe(false);
  });

  it("lets a workspace's override of a system key win", () => {
    const [systemId] = [...SYSTEM_STYLE_MAP.keys()];
    const merged = mergeCatalogue(SYSTEM_STYLE_MAP, { [systemId!]: { name: "Overridden" } });
    expect(merged.get(systemId!)).toMatchObject({ id: systemId, name: "Overridden" });
  });
});
