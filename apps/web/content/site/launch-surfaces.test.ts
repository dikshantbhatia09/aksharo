import { describe, expect, it } from "vitest";

import {
  ALL_LAUNCH_SURFACES,
  assertServerSurfaceEnabled,
  isServerSurfaceEnabled,
  LAUNCH_SURFACE_FLAGS,
  surfaceEnabled,
} from "./launch-surfaces";
import { FOOTER_PRODUCT_NAV, PRIMARY_NAV, visibleNav } from "./nav";

const NON_WEB_SURFACES = ALL_LAUNCH_SURFACES.filter((name) => name !== "web");

describe("launch surfaces", () => {
  /**
   * Every non-web surface leads to something that is not in this Git HEAD, or to a
   * code path that throws "not implemented". A surface that has to be
   * remembered is a surface that ships half-built (P0-12).
   */
  it("is off for every non-web surface unless a flag says otherwise", () => {
    for (const surface of NON_WEB_SURFACES) {
      expect(surfaceEnabled(surface, {}), surface).toBe(false);
    }
  });

  it("treats web as the active baseline surface for web-only beta release", () => {
    expect(surfaceEnabled("web", {})).toBe(true);
    expect(surfaceEnabled("web", { [LAUNCH_SURFACE_FLAGS.web]: false })).toBe(false);
  });

  it("turns on only the surface its own flag names", () => {
    const flags = { [LAUNCH_SURFACE_FLAGS.desktop]: true };
    expect(surfaceEnabled("desktop", flags)).toBe(true);
    for (const surface of NON_WEB_SURFACES.filter((name) => name !== "desktop")) {
      expect(surfaceEnabled(surface, flags), surface).toBe(false);
    }
  });

  it("treats an explicit false like an absent flag for unreleased surfaces", () => {
    expect(surfaceEnabled("plugins", { [LAUNCH_SURFACE_FLAGS.plugins]: false })).toBe(false);
    expect(surfaceEnabled("affiliates", { [LAUNCH_SURFACE_FLAGS.affiliates]: false })).toBe(false);
    expect(surfaceEnabled("publicShares", { [LAUNCH_SURFACE_FLAGS.publicShares]: false })).toBe(
      false,
    );
  });

  it("evaluates server availability from process.env.FEATURE_FLAGS_JSON", () => {
    const originalEnv = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({
        [LAUNCH_SURFACE_FLAGS.desktop]: true,
        [LAUNCH_SURFACE_FLAGS.plugins]: false,
      });
      expect(isServerSurfaceEnabled("desktop")).toBe(true);
      expect(isServerSurfaceEnabled("plugins")).toBe(false);
      expect(isServerSurfaceEnabled("publicShares")).toBe(false);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = originalEnv;
    }
  });

  it("assertServerSurfaceEnabled calls notFound when surface is disabled", () => {
    const originalEnv = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = "{}";
      expect(() => assertServerSurfaceEnabled("desktop")).toThrow();
      expect(() => assertServerSurfaceEnabled("plugins")).toThrow();
      expect(() => assertServerSurfaceEnabled("publicShares")).toThrow();
      // web is enabled by default, so it does not throw
      expect(() => assertServerSurfaceEnabled("web")).not.toThrow();
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = originalEnv;
    }
  });

  it("assertServerSurfaceEnabled passes without throwing when surface is enabled", () => {
    const originalEnv = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({
        [LAUNCH_SURFACE_FLAGS.desktop]: true,
        [LAUNCH_SURFACE_FLAGS.plugins]: true,
      });
      expect(() => assertServerSurfaceEnabled("desktop")).not.toThrow();
      expect(() => assertServerSurfaceEnabled("plugins")).not.toThrow();
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = originalEnv;
    }
  });
});

describe("visibleNav", () => {
  it("drops the links whose product this release does not ship", () => {
    const hrefs = visibleNav(PRIMARY_NAV, {}).map((item) => item.href);
    expect(hrefs).not.toContain("/plugins");
    expect(hrefs).not.toContain("/download");
    // The surfaces that DO ship are untouched.
    expect(hrefs).toContain("/features");
    expect(hrefs).toContain("/pricing");
    expect(hrefs).toContain("/styles");
  });

  it("restores a link when its surface ships", () => {
    const flags = {
      [LAUNCH_SURFACE_FLAGS.desktop]: true,
      [LAUNCH_SURFACE_FLAGS.plugins]: true,
    };
    const hrefs = visibleNav(PRIMARY_NAV, flags).map((item) => item.href);
    expect(hrefs).toContain("/plugins");
    expect(hrefs).toContain("/download");
    expect(visibleNav(PRIMARY_NAV, flags)).toHaveLength(PRIMARY_NAV.length);
  });

  it("filters the footer the same way as the header", () => {
    const hrefs = visibleNav(FOOTER_PRODUCT_NAV, {}).map((item) => item.href);
    expect(hrefs).not.toContain("/plugins");
    expect(hrefs).not.toContain("/download");
    expect(hrefs).toContain("/changelog");
  });

  it("leaves a list with no surface-gated items alone", () => {
    const items = [{ label: "Pricing", href: "/pricing" }];
    expect(visibleNav(items, {})).toEqual(items);
  });
});
