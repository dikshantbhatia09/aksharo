"use client";

/**
 * Console-error ring buffer (brief §5: "a console-error ring buffer"),
 * capped at 20 entries — the same ceiling the API enforces server-side
 * (`SupportDiagnosticsSchema.consoleErrors`, `apps/api/src/support/
 * support.dto.ts`) as a second line of defence. Wraps `console.error` once,
 * for the life of the tab; never touches `console.log`/`warn` — this is for
 * genuine errors, not noise.
 */
const RING_BUFFER_LIMIT = 20;
const ring: string[] = [];
let installed = false;

export function installConsoleErrorRingBuffer(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const message = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
    ring.push(message.slice(0, 500));
    if (ring.length > RING_BUFFER_LIMIT) ring.shift();
    original(...args);
  };
}

export function recentConsoleErrors(): string[] {
  return [...ring].slice(-RING_BUFFER_LIMIT);
}

/** Best-effort browser/OS label from the user agent — never a fingerprinting-grade parse. */
export function describeUserAgent(): { browser: string; os: string } {
  if (typeof navigator === "undefined") return { browser: "unknown", os: "unknown" };
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "unknown browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Linux/.test(ua)
        ? "Linux"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : "unknown OS";
  return { browser, os };
}

/** The web app's own version — matches `apps/web/package.json`. */
export const APP_VERSION = "0.1.0";
