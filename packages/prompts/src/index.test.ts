import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/prompts", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/prompts");
    expect(PACKAGE_INFO.implementedBy).toBe("B11 (prompts), D08 (eval harness)");
  });

  it("is still a skeleton until B11 lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
