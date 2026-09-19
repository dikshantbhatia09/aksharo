import { describe, expect, it } from "vitest";

import {
  ALL_LAUNCH_SURFACES,
  DEFAULT_SURFACE_AVAILABILITY,
  LAUNCH_SURFACE_FLAGS,
  surfaceEnabled,
  type LaunchSurface,
} from "./launch-surfaces";

describe("canonical launch-surfaces matrix", () => {
  it("defines all required surfaces from RLS-006 scope", () => {
    const requiredSurfaces: LaunchSurface[] = [
      "web",
      "desktop",
      "plugins",
      "checkout",
      "affiliates",
      "partnerCatalogue",
      "publicShares",
    ];
    for (const surface of requiredSurfaces) {
      expect(ALL_LAUNCH_SURFACES).toContain(surface);
      // eslint-disable-next-line security/detect-object-injection -- RLS-008 (@aksharo/release-dx): internal enumerated surface key
      expect(LAUNCH_SURFACE_FLAGS[surface]).toBeDefined();
    }
  });

  it("fails closed in production: only web defaults to true; all unready surfaces default to false", () => {
    expect(surfaceEnabled("web", {})).toBe(true);
    expect(DEFAULT_SURFACE_AVAILABILITY.web).toBe(true);

    const nonWebSurfaces = ALL_LAUNCH_SURFACES.filter((s) => s !== "web");
    for (const surface of nonWebSurfaces) {
      expect(surfaceEnabled(surface, {}), surface).toBe(false);
      // eslint-disable-next-line security/detect-object-injection -- RLS-008 (@aksharo/release-dx): internal enumerated surface key
      expect(DEFAULT_SURFACE_AVAILABILITY[surface], surface).toBe(false);
    }
  });

  it("handles null, undefined, or empty flags gracefully without throwing", () => {
    expect(surfaceEnabled("web", null)).toBe(true);
    expect(surfaceEnabled("web", undefined)).toBe(true);
    expect(surfaceEnabled("desktop", null)).toBe(false);
    expect(surfaceEnabled("desktop", undefined)).toBe(false);
  });

  it("enables only the surface whose flag is explicitly set to true", () => {
    for (const surface of ALL_LAUNCH_SURFACES) {
      // eslint-disable-next-line security/detect-object-injection -- RLS-008 (@aksharo/release-dx): internal enumerated surface key
      const flagKey = LAUNCH_SURFACE_FLAGS[surface];
      const flags = { [flagKey]: true };
      expect(surfaceEnabled(surface, flags), surface).toBe(true);
    }
  });

  it("honors explicit false overrides for every surface including web", () => {
    expect(surfaceEnabled("web", { [LAUNCH_SURFACE_FLAGS.web]: false })).toBe(false);
    expect(surfaceEnabled("desktop", { [LAUNCH_SURFACE_FLAGS.desktop]: false })).toBe(false);
    expect(surfaceEnabled("plugins", { [LAUNCH_SURFACE_FLAGS.plugins]: false })).toBe(false);
    expect(surfaceEnabled("checkout", { [LAUNCH_SURFACE_FLAGS.checkout]: false })).toBe(false);
    expect(surfaceEnabled("affiliates", { [LAUNCH_SURFACE_FLAGS.affiliates]: false })).toBe(false);
    expect(
      surfaceEnabled("partnerCatalogue", { [LAUNCH_SURFACE_FLAGS.partnerCatalogue]: false }),
    ).toBe(false);
    expect(surfaceEnabled("publicShares", { [LAUNCH_SURFACE_FLAGS.publicShares]: false })).toBe(
      false,
    );
  });
});
