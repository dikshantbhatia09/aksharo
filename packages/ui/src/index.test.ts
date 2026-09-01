import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/ui", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/ui");
    expect(PACKAGE_INFO.implementedBy).toBe("A13");
  });

  it("is still a skeleton until A13 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
