import { describe, expect, it } from "vitest";

import { LAUNCH_SURFACE_FLAGS, surfaceEnabled, type LaunchSurface } from "./launch-surfaces";
import { FOOTER_PRODUCT_NAV, PRIMARY_NAV, visibleNav } from "./nav";

const ALL_SURFACES = Object.keys(LAUNCH_SURFACE_FLAGS) as LaunchSurface[];

describe("launch surfaces", () => {
  /**
   * Every one of these leads to something that is not in this Git HEAD, or to a
   * code path that throws "not implemented". A surface that has to be
   * remembered is a surface that ships half-built (P0-12).
   */
  it("is off for every surface unless a flag says otherwise", () => {
    for (const surface of ALL_SURFACES) {
      expect(surfaceEnabled(surface, {}), surface).toBe(false);
    }
  });

  it("turns on only the surface its own flag names", () => {
    const flags = { [LAUNCH_SURFACE_FLAGS.desktop]: true };
    expect(surfaceEnabled("desktop", flags)).toBe(true);
    for (const surface of ALL_SURFACES.filter((name) => name !== "desktop")) {
      expect(surfaceEnabled(surface, flags), surface).toBe(false);
    }
  });

  it("treats an explicit false like an absent flag", () => {
    expect(surfaceEnabled("plugins", { [LAUNCH_SURFACE_FLAGS.plugins]: false })).toBe(false);
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
