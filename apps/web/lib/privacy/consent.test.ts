import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyticsAllowed,
  DEFAULT_PRIVACY,
  readPrivacy,
  subscribePrivacy,
  toConsents,
  writePrivacy,
} from "./consent";

describe("the privacy mirror", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to no for everything (D60)", () => {
    expect(readPrivacy()).toEqual(DEFAULT_PRIVACY);
    expect(DEFAULT_PRIVACY).toEqual({
      analytics: false,
      memory: false,
      marketing: false,
      minor: false,
    });
  });

  it("round-trips a decision", () => {
    writePrivacy({ analytics: true, memory: true });
    expect(readPrivacy()).toMatchObject({ analytics: true, memory: true, marketing: false });
  });

  it("reads corrupt storage as no rather than as yes", () => {
    window.localStorage.setItem("aksharo.privacy", "{not json");
    expect(readPrivacy()).toEqual(DEFAULT_PRIVACY);
  });

  it("treats a truthy non-boolean as no", () => {
    window.localStorage.setItem("aksharo.privacy", JSON.stringify({ analytics: "yes" }));
    expect(readPrivacy().analytics).toBe(false);
  });

  it("survives storage being unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPrivacy()).toEqual(DEFAULT_PRIVACY);
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writePrivacy({ analytics: true })).not.toThrow();
    setItem.mockRestore();
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePrivacy(listener);
    writePrivacy({ memory: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ memory: true }));
    unsubscribe();
    writePrivacy({ memory: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("analyticsAllowed", () => {
  it("needs consent", () => {
    expect(
      analyticsAllowed({ analytics: false, memory: false, marketing: false, minor: false }),
    ).toBe(false);
    expect(
      analyticsAllowed({ analytics: true, memory: false, marketing: false, minor: false }),
    ).toBe(true);
  });

  it("is off for a declared minor whatever the toggle says (D60)", () => {
    expect(
      analyticsAllowed({ analytics: true, memory: false, marketing: false, minor: true }),
    ).toBe(false);
  });
});

describe("toConsents", () => {
  it("maps the mirror onto the API's purposes", () => {
    expect(toConsents({ analytics: true, memory: false, marketing: true })).toEqual({
      analytics: true,
      memory: false,
      marketing: true,
    });
  });
});
