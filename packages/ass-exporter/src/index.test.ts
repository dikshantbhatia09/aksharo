import { describe, expect, it } from "vitest";

import { PACKAGE_INFO } from "./index.js";

describe("@montaj/ass-exporter", () => {
  it("declares its identity and its owning work package", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/ass-exporter");
    expect(PACKAGE_INFO.implementedBy).toBe("A18a");
  });

  it("is still a skeleton until A18a lands", () => {
    expect(PACKAGE_INFO.implemented).toBe(false);
  });
});
