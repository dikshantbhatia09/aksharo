import { describe, expect, it } from "vitest";

import { EMPTY_RUN_SETUP, runSetupRequest, runSetupValueOf } from "./RunSetupFields";

/**
 * `setup.brand` (2026-10-02): sent only for what the form offered and left on
 * - Autopilot (a channel's runs always are), a saved kit, and the switch.
 */
describe("runSetupRequest - the brand kit", () => {
  it("asks for the brand only with Autopilot, a saved kit and the switch on", () => {
    expect(runSetupRequest(EMPTY_RUN_SETUP, { brandKit: true }).brand).toBe(true);
    expect(runSetupRequest(EMPTY_RUN_SETUP).brand).toBeUndefined();
    expect(
      runSetupRequest({ ...EMPTY_RUN_SETUP, useBrand: false }, { brandKit: true }).brand,
    ).toBeUndefined();
    expect(
      runSetupRequest({ ...EMPTY_RUN_SETUP, autopilot: false }, { brandKit: true }).brand,
    ).toBeUndefined();
  });

  it("asks for it on a channel's runs, which are always Autopilot", () => {
    const setup = runSetupRequest(
      { ...EMPTY_RUN_SETUP, autopilot: false },
      { forChannel: true, brandKit: true },
    );
    expect(setup.automation).toBe("auto");
    expect(setup.brand).toBe(true);
  });

  it("reads a saved setup's brand back, off when it was not asked for", () => {
    const branded = runSetupRequest(EMPTY_RUN_SETUP, { brandKit: true });
    expect(runSetupValueOf(branded).useBrand).toBe(true);
    expect(runSetupValueOf(runSetupRequest(EMPTY_RUN_SETUP)).useBrand).toBe(false);
  });
});
