import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/timemap", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/timemap");
    expect(PACKAGE_INFO.implementedBy).toBe("A02c");
  });

  it("is still a skeleton until A02c lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
