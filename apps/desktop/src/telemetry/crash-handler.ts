import { redactText, tailAndRedact } from "@montaj/bridge-core";

import type { LogRingBuffer } from "./log-ring-buffer.js";

const LOG_TAIL_LIMIT = 50;

export interface CrashPayload {
  readonly clientKind: "desktop";
  readonly appVersion: string;
  readonly osVersion: string;
  readonly stack: string;
  readonly logTail: string[];
}

export interface CrashHandlerOptions {
  readonly appVersion: string;
  readonly osVersion: string;
  readonly logs: LogRingBuffer;
  /** Called with an already-redacted, ready-to-queue crash payload. */
  readonly onCrash: (payload: CrashPayload) => void;
}

/** Builds the redacted payload for one crash — the part every hook shares. */
export function buildCrashPayload(
  error: { message: string; stack?: string },
  options: Pick<CrashHandlerOptions, "appVersion" | "osVersion" | "logs">,
): CrashPayload {
  const rawStack = error.stack ?? error.message;
  return {
    clientKind: "desktop",
    appVersion: options.appVersion,
    osVersion: options.osVersion,
    stack: redactText(rawStack),
    logTail: tailAndRedact(options.logs.lines(), LOG_TAIL_LIMIT),
  };
}

/**
 * The subset of Node's `process` and Electron's `app`/`webContents` events
 * this installs against — injected so the pure logic (redaction, payload
 * shape) is unit-testable without a real Electron runtime, matching this
 * package's coverage carve-out (main/preload wiring -> Playwright smoke).
 */
export interface CrashSources {
  onUncaughtException(listener: (error: Error) => void): void;
  onUnhandledRejection(listener: (reason: unknown) => void): void;
  /** One per renderer `WebContents`; `main/index.ts` calls this per window. */
  onRendererGone(listener: (details: { reason: string; exitCode: number }) => void): void;
}

/**
 * Installs the crash handler (brief §2: `process.on("uncaughtException")`,
 * renderer `"crashed"`/`render-process-gone`). Never rethrows and never exits
 * the process itself — that decision belongs to `main/index.ts` (Electron's
 * own crash-reporter or a clean restart), this only ever gets one redacted
 * payload to `onCrash` before whatever else the caller does.
 */
export function installCrashHandler(sources: CrashSources, options: CrashHandlerOptions): void {
  sources.onUncaughtException((error) => {
    options.onCrash(buildCrashPayload(error, options));
  });
  sources.onUnhandledRejection((reason) => {
    const error =
      reason instanceof Error ? reason : { message: `Unhandled rejection: ${String(reason)}` };
    options.onCrash(buildCrashPayload(error, options));
  });
  sources.onRendererGone(({ reason, exitCode }) => {
    options.onCrash(
      buildCrashPayload(
        { message: `renderer process gone: ${reason} (exit ${String(exitCode)})` },
        options,
      ),
    );
  });
}
