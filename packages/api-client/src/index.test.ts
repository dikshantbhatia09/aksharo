import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/api-client", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/api-client");
    expect(PACKAGE_INFO.implementedBy).toBe("A03 (spec), A13 (hooks)");
  });

  it("is still a skeleton until A03 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
