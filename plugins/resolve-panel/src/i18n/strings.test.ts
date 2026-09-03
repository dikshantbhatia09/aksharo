import { describe, expect, it } from "vitest";

import { t } from "./strings.js";

describe("t()", () => {
  it("returns the English string by default", () => {
    expect(t("passes.title")).toBe("Passes");
  });

  it("interpolates placeholders", () => {
    expect(t("status.error", { message: "network down" })).toBe(
      "Something went wrong: network down",
    );
  });

  it("returns the Hindi string for locale hi", () => {
    expect(t("passes.title", {}, "hi")).toBe("पासेस");
  });
});
