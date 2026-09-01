import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/render-core", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/render-core");
    expect(PACKAGE_INFO.implementedBy).toBe("A16");
  });

  it("is still a skeleton until A16 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
