import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/edg", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/edg");
    expect(PACKAGE_INFO.implementedBy).toBe("A02 (types + schemas), A02b (ops engine)");
  });

  it("is still a skeleton until A02 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
