import { describe, expect, it } from "vitest";

import { PICKABLE_STYLE_IDS } from "@montaj/caption-styles";

import { clipDocumentStyle } from "./clip-style.js";

describe("clipDocumentStyle", () => {
  it("honours a style the person can pick", () => {
    const pickable = PICKABLE_STYLE_IDS[0] ?? "punch-pop";
    expect(clipDocumentStyle({ styleId: pickable, scriptMode: "auto", styleVersion: 1 })).toBe(
      pickable,
    );
  });

  it("keeps the document's own default for a style that is no longer pickable", () => {
    // Two of the three live clips were made from runs that froze a retired id.
    expect(clipDocumentStyle({ styleId: "vertical-clean" })).toBeUndefined();
    expect(clipDocumentStyle({ styleId: "preset:01JCPRESET0000000000000000" })).toBeUndefined();
  });

  it("keeps the default when the setup carries no style at all", () => {
    expect(clipDocumentStyle({})).toBeUndefined();
    expect(clipDocumentStyle(null)).toBeUndefined();
    expect(clipDocumentStyle({ styleId: 7 })).toBeUndefined();
  });
});
