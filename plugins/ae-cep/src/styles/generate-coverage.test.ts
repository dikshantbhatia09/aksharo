import { describe, expect, it } from "vitest";

import { buildAeStyleMap } from "./ae-style-map.js";
import { renderMarkdown } from "./generate-coverage.js";

describe("renderMarkdown", () => {
  it("lists every style once", () => {
    const mapping = buildAeStyleMap();
    const markdown = renderMarkdown(mapping);
    for (const entry of mapping) {
      expect(markdown).toContain(`\`${entry.styleId}\``);
    }
    expect(markdown).toContain(`${mapping.length} styles`);
  });

  it("is deterministic", () => {
    const mapping = buildAeStyleMap();
    expect(renderMarkdown(mapping)).toBe(renderMarkdown(mapping));
  });
});
