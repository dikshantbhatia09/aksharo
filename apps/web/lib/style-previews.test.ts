import { describe, expect, it } from "vitest";

import { stylePreviewUrl } from "./style-previews";

describe("stylePreviewUrl", () => {
  it("resolves a preview key to this app's own static path", () => {
    expect(stylePreviewUrl("punch-pop.png")).toBe("/style-previews/punch-pop.png");
  });
});
