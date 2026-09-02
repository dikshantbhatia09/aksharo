import { describe, expect, it } from "vitest";

import { detectDesktopEnvironment, getDesktopApi } from "./desktop.js";

describe("detectDesktopEnvironment", () => {
  it("detects the desktop shell via the ?desktop=1 query flag", () => {
    const result = detectDesktopEnvironment({ searchParams: new URLSearchParams("desktop=1") });
    expect(result.isDesktop).toBe(true);
  });

  it("detects the desktop shell via the User-Agent suffix and extracts the version", () => {
    const result = detectDesktopEnvironment({
      searchParams: null,
      userAgent: "Mozilla/5.0 Chrome/130 AksharoDesktop/1.2.3",
    });
    expect(result).toEqual({ isDesktop: true, version: "1.2.3" });
  });

  it("is not desktop for an ordinary browser request", () => {
    const result = detectDesktopEnvironment({
      searchParams: new URLSearchParams(""),
      userAgent: "Mozilla/5.0 Chrome/130",
    });
    expect(result).toEqual({ isDesktop: false, version: null });
  });
});

describe("getDesktopApi", () => {
  it("returns null when window.aksharoDesktop is not present", () => {
    expect(getDesktopApi()).toBeNull();
  });
});
