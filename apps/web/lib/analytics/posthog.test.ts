import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAnalyticsForTests,
  configureAnalytics,
  identify,
  initAnalyticsIfConsented,
  resetAnalytics,
  track,
} from "./posthog";

import { writePrivacy } from "@/lib/privacy/consent";

/**
 * The rule this file exists to enforce: **`posthog-js` is not loaded, imported
 * or contacted before the analytics consent exists** (brief §7, D60). The mock
 * counts imports, so a regression that merely constructs the client — without
 * sending an event — still fails.
 */

const init = vi.fn();
const capture = vi.fn();
const identifyMock = vi.fn();
const reset = vi.fn();
const optOut = vi.fn();
let imports = 0;

vi.mock("posthog-js", () => {
  imports += 1;
  return {
    default: {
      init,
      capture,
      identify: identifyMock,
      reset,
      opt_out_capturing: optOut,
    },
  };
});

/** Let the dynamic import settle. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  imports = 0;
  window.localStorage.clear();
  __resetAnalyticsForTests();
  configureAnalytics({ key: "phc_test", host: "https://posthog.test" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("analytics consent gate", () => {
  it("does not load posthog before consent", async () => {
    initAnalyticsIfConsented();
    track("shell.viewed");
    identify("01JUSER");
    await flush();

    expect(imports).toBe(0);
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not load posthog for a declared minor who ticked the box", async () => {
    writePrivacy({ analytics: true, minor: true });
    initAnalyticsIfConsented();
    track("shell.viewed");
    await flush();

    expect(imports).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it("does not load posthog when no project key is configured", async () => {
    configureAnalytics({ key: null, host: "https://posthog.test" });
    writePrivacy({ analytics: true });
    track("shell.viewed");
    await flush();

    expect(imports).toBe(0);
  });

  it("loads once consent exists, and only once", async () => {
    writePrivacy({ analytics: true });
    track("shell.viewed", { route: "/studio" });
    await flush();
    track("project.created");
    await flush();

    expect(imports).toBe(1);
    expect(init).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenNthCalledWith(1, "shell.viewed", { route: "/studio" });
    expect(capture).toHaveBeenNthCalledWith(2, "project.created", undefined);
  });

  it("initialises with autocapture, page views, session recording and PII off", async () => {
    writePrivacy({ analytics: true });
    initAnalyticsIfConsented();
    await flush();

    const options = init.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(init.mock.calls[0]?.[0]).toBe("phc_test");
    expect(options["autocapture"]).toBe(false);
    expect(options["capture_pageview"]).toBe(false);
    expect(options["disable_session_recording"]).toBe(true);
    expect(options["property_denylist"]).toContain("email");
  });

  it("opts out and resets on sign-out", async () => {
    writePrivacy({ analytics: true });
    track("shell.viewed");
    await flush();

    resetAnalytics();
    expect(optOut).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("stops capturing the moment consent is withdrawn", async () => {
    writePrivacy({ analytics: true });
    track("one");
    await flush();
    capture.mockClear();

    writePrivacy({ analytics: false });
    track("two");
    await flush();
    expect(capture).not.toHaveBeenCalled();
  });

  it("identifies by user id only", async () => {
    writePrivacy({ analytics: true });
    identify("01JUSER", { plan: "creator" });
    await flush();
    expect(identifyMock).toHaveBeenCalledWith("01JUSER", { plan: "creator" });
  });
});
