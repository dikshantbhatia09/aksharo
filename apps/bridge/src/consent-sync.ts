/**
 * Bridge-side sync for the `telemetry` consent purpose (M04, C12 follow-up).
 *
 * `config.ts` previously flagged this: `telemetryConsent` defaulted to
 * `false` with "no consent-read call exists in this process today". This
 * module is that call — `GET /consents`, the same read a browser session
 * makes, now reachable with a bridge token because `ConsentsController.list`
 * opted in with `@AllowBridgeToken()`.
 *
 * **Why polling, not a pushed event.** The brief for this fix asked for a
 * refresh "on consent.withdrawn/granted events over the relay". This
 * repository's bridge relay (`bridge-relay.gateway.ts`) pairs exactly one
 * bridge connection with one *client* connection to forward opaque JSON-RPC
 * frames between them (C01 brief §3) — there is no channel today for the API
 * itself to push a server-side event (like `consent.withdrawn`,
 * `memory/consent-events.ts`) down to an unpaired bridge process, and adding
 * one is a protocol change to `bridge-relay.gateway.ts` well beyond this
 * fix's scope. `fetchTelemetryConsent` is the same idempotent read either a
 * push or a poll would ultimately call, so `main.ts` calls it once on startup
 * and again on a plain interval (`startConsentPolling`) — a "granted" or
 * "withdrawn" answer from the server is picked up within one poll interval
 * either way, and the mechanism costs nothing new in the API or the relay
 * protocol. Flagged for the orchestrator as the same kind of deviation
 * `memory/consent-events.ts` already documents.
 */

export interface TelemetryConsentFetchOptions {
  readonly apiOrigin: string;
  readonly deviceToken: string;
  /** Injected for testability; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface ConsentsResponseShape {
  readonly purposes: readonly { readonly purpose: string; readonly granted: boolean }[];
}

/**
 * Reads `GET /consents` with the bridge's own device token and returns
 * whether the `telemetry` purpose is currently granted.
 *
 * Never throws: a network failure or a non-2xx response is not evidence the
 * user withdrew consent, so on any error this returns `undefined` and the
 * caller keeps whatever answer it already has (fail safe, not fail open —
 * `main.ts` only ever starts the telemetry client when a fetch here actually
 * returned `true`).
 */
export async function fetchTelemetryConsent(
  options: TelemetryConsentFetchOptions,
): Promise<boolean | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.apiOrigin}/consents`, {
      headers: { authorization: `Bearer ${options.deviceToken}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as ConsentsResponseShape;
    const telemetry = body.purposes.find((entry) => entry.purpose === "telemetry");
    return telemetry?.granted ?? false;
  } catch {
    return undefined;
  }
}

export interface ConsentPollHandle {
  stop(): void;
}

/**
 * Polls {@link fetchTelemetryConsent} on `intervalMs` and calls `onChange`
 * whenever the answer differs from the last known one (including the first
 * successful read). Returns a handle whose `stop()` clears the timer —
 * `main.ts` calls it from the same shutdown path that stops `BridgeCore`.
 */
export function startConsentPolling(
  options: TelemetryConsentFetchOptions & {
    readonly intervalMs: number;
    readonly onChange: (granted: boolean) => void;
    /** The last known answer, so a poll that confirms it does not re-fire. */
    initialKnown?: boolean;
  },
): ConsentPollHandle {
  let known = options.initialKnown;
  const timer = setInterval(() => {
    void fetchTelemetryConsent(options).then((granted) => {
      if (granted !== undefined && granted !== known) {
        known = granted;
        options.onChange(granted);
      }
    });
  }, options.intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
