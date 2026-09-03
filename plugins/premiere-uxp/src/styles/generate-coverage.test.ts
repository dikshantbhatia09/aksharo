import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./generate-coverage.js";
import { buildMogrtStyleMap } from "./mogrt-map.js";

describe("renderMarkdown", () => {
  it("lists every style once, in a supported or unsupported table", () => {
    const mapping = buildMogrtStyleMap();
    const markdown = renderMarkdown(mapping);
    for (const entry of mapping) {
      expect(markdown).toContain(`\`${entry.styleId}\``);
    }
    expect(markdown).toContain(`${mapping.length} styles`);
  });

  it("is deterministic", () => {
    const mapping = buildMogrtStyleMap();
    expect(renderMarkdown(mapping)).toBe(renderMarkdown(mapping));
  });
});
