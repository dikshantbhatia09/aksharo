import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/caption-styles", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/caption-styles");
    expect(PACKAGE_INFO.implementedBy).toBe("A02 (schema), A16 (styles), A18a (parity flags)");
  });

  it("is still a skeleton until A02 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
