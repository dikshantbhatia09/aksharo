import { redactText, tailAndRedact } from "@montaj/bridge-core";

const LOG_TAIL_LIMIT = 50;

export interface TelemetryClientOptions {
  readonly apiOrigin: string;
  readonly deviceToken: string;
  readonly appVersion: string;
  /** Injected for testability; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The bridge's own reporter (brief §2: "the local bridge ... report its own
 * crashes and lifecycle events"). Unlike the desktop shell, the bridge is a
 * headless background process that already holds a live `kind:"bridge"`
 * device token (B08b) and has no renderer to hand the call to, so it posts
 * directly rather than through an offline queue: best-effort, fire-and-forget
 * — a dropped event when the API is briefly unreachable costs nothing the
 * bridge's own "no respawn, exit non-zero on unrecovered error" contract
 * (`main.ts`'s doc comment) doesn't already accept.
 *
 * Consent is not re-checked here: the caller (`main.ts`) only constructs this
 * client after confirming the `telemetry` consent is granted, the same
 * pattern C02's desktop shell uses (gate before queuing, not inside the
 * queue). The API re-checks consent server-side regardless (defense in
 * depth — `TelemetryService.assertConsent`).
 */
export function createTelemetryClient(options: TelemetryClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<void> {
    const response = await fetchImpl(`${options.apiOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.deviceToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`telemetry POST ${path} failed: ${String(response.status)}`);
    }
  }

  return {
    /** Fire-and-forget: logs (via the caller's own logger) rather than throws. */
    async reportEvent(kind: string, props: Record<string, unknown> = {}): Promise<{ ok: boolean }> {
      try {
        await post("/telemetry/events", {
          events: [
            {
              eventId: `bridge-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
              kind,
              at: new Date().toISOString(),
              appVersion: options.appVersion,
              props,
            },
          ],
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    async reportCrash(
      error: { message: string; stack?: string },
      osVersion: string,
      logLines: readonly string[] = [],
    ): Promise<{ ok: boolean }> {
      try {
        await post("/telemetry/crash", {
          clientKind: "bridge",
          appVersion: options.appVersion,
          osVersion,
          stack: redactText(error.stack ?? error.message),
          logTail: tailAndRedact(logLines, LOG_TAIL_LIMIT),
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

export type TelemetryClient = ReturnType<typeof createTelemetryClient>;
