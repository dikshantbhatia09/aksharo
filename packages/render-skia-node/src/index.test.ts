import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/render-skia-node", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/render-skia-node");
    expect(PACKAGE_INFO.implementedBy).toBe("A20");
  });

  it("is still a skeleton until A20 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
