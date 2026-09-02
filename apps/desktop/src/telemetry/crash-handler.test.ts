import { describe, expect, it, vi } from "vitest";

import { buildCrashPayload, installCrashHandler, type CrashSources } from "./crash-handler.js";
import { createLogRingBuffer } from "./log-ring-buffer.js";

describe("buildCrashPayload", () => {
  it("redacts the stack and the log tail", () => {
    const logs = createLogRingBuffer();
    logs.push("started at C:\\Users\\dikshant\\AppData\\Local");
    logs.push("user email leak@example.com");

    const payload = buildCrashPayload(
      { message: "boom", stack: "Error: boom\n at file.js:1:1 token=" + "a".repeat(40) },
      { appVersion: "1.0.0", osVersion: "Windows 11", logs },
    );

    expect(payload.clientKind).toBe("desktop");
    expect(payload.stack).not.toContain("a".repeat(40));
    expect(payload.logTail.some((l) => l.includes("dikshant"))).toBe(false);
    expect(payload.logTail.some((l) => l.includes("leak@example.com"))).toBe(false);
  });

  it("falls back to the message when there is no stack", () => {
    const logs = createLogRingBuffer();
    const payload = buildCrashPayload(
      { message: "no stack here" },
      { appVersion: "1.0.0", osVersion: "Windows 11", logs },
    );
    expect(payload.stack).toBe("no stack here");
  });
});

describe("installCrashHandler", () => {
  function fakeSources(): CrashSources & {
    fireUncaught: (e: Error) => void;
    fireRejection: (r: unknown) => void;
    fireRendererGone: (d: { reason: string; exitCode: number }) => void;
  } {
    let uncaught: ((e: Error) => void) | undefined;
    let rejection: ((r: unknown) => void) | undefined;
    let rendererGone: ((d: { reason: string; exitCode: number }) => void) | undefined;
    return {
      onUncaughtException: (listener) => {
        uncaught = listener;
      },
      onUnhandledRejection: (listener) => {
        rejection = listener;
      },
      onRendererGone: (listener) => {
        rendererGone = listener;
      },
      fireUncaught: (e) => uncaught?.(e),
      fireRejection: (r) => rejection?.(r),
      fireRendererGone: (d) => rendererGone?.(d),
    };
  }

  it("calls onCrash for an uncaught exception", () => {
    const sources = fakeSources();
    const onCrash = vi.fn();
    installCrashHandler(sources, {
      appVersion: "1.0.0",
      osVersion: "Windows 11",
      logs: createLogRingBuffer(),
      onCrash,
    });
    sources.fireUncaught(new Error("kaboom"));
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash.mock.calls[0]?.[0]).toMatchObject({ clientKind: "desktop" });
  });

  it("calls onCrash for an unhandled rejection, even a non-Error reason", () => {
    const sources = fakeSources();
    const onCrash = vi.fn();
    installCrashHandler(sources, {
      appVersion: "1.0.0",
      osVersion: "Windows 11",
      logs: createLogRingBuffer(),
      onCrash,
    });
    sources.fireRejection("just a string");
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect((onCrash.mock.calls[0]?.[0] as { stack: string }).stack).toContain("just a string");
  });

  it("calls onCrash when a renderer goes away", () => {
    const sources = fakeSources();
    const onCrash = vi.fn();
    installCrashHandler(sources, {
      appVersion: "1.0.0",
      osVersion: "Windows 11",
      logs: createLogRingBuffer(),
      onCrash,
    });
    sources.fireRendererGone({ reason: "crashed", exitCode: 1 });
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect((onCrash.mock.calls[0]?.[0] as { stack: string }).stack).toContain("crashed");
  });
});
