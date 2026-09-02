/**
 * The desktop shell's own local mirror of the `telemetry` consent (brief §2:
 * "consent prompt on first run ... and toggle in Settings via the preload
 * API"). The server row (`consent_records`, via the hosted web app's own
 * `POST /consents`) is the source of truth; this local flag is what gates
 * whether the main process's crash handler and offline queue are allowed to
 * queue anything at all *before* a network round trip, and what tells the
 * first-run flow whether the prompt has already been answered.
 *
 * Read/write is injected (`ConsentFileIO`), same reasoning as
 * `offline-queue.ts`: real `fs` in the main process, an in-memory stand-in in
 * tests.
 */
export interface ConsentFileIO {
  readText(path: string): string | undefined;
  writeText(path: string, content: string): void;
}

export interface TelemetryConsentState {
  readonly granted: boolean;
  /** `undefined` until the first-run prompt has ever been answered. */
  readonly decidedAt?: string;
}

export interface TelemetryConsentStore {
  get(): TelemetryConsentState;
  set(granted: boolean, at?: Date): TelemetryConsentState;
  /** Has the first-run prompt ever been answered? */
  hasDecided(): boolean;
}

const UNDECIDED: TelemetryConsentState = { granted: false };

export function createConsentStore(path: string, io: ConsentFileIO): TelemetryConsentStore {
  function load(): TelemetryConsentState {
    const raw = io.readText(path);
    if (raw === undefined) return UNDECIDED;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "granted" in parsed &&
        typeof (parsed as { granted: unknown }).granted === "boolean"
      ) {
        return parsed as TelemetryConsentState;
      }
      return UNDECIDED;
    } catch {
      return UNDECIDED;
    }
  }

  return {
    get: load,
    set(granted, at = new Date()) {
      const state: TelemetryConsentState = { granted, decidedAt: at.toISOString() };
      io.writeText(path, JSON.stringify(state));
      return state;
    },
    hasDecided() {
      return load().decidedAt !== undefined;
    },
  };
}
