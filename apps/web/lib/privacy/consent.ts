"use client";

import type { Consents } from "@montaj/api-client";

/**
 * The browser's copy of what the user agreed to.
 *
 * The server is the record of consent (`consent_records`, one row per decision,
 * refusals included), but analytics has to decide whether to load *before* any
 * authenticated request can be made — on the sign-up page, on the first paint
 * after a reload — so the browser keeps a mirror.
 *
 * The mirror is written only from a decision the user just made or a decision
 * the API just returned, and its default is "no to everything" (D60): a missing
 * mirror can never be read as consent.
 */

export interface PrivacySnapshot {
  analytics: boolean;
  memory: boolean;
  marketing: boolean;
  /** C12: desktop/plugin telemetry and crash reporting. Off until granted. */
  telemetry: boolean;
  /**
   * D60: for a declared minor, product analytics, streaks, referral and
   * affiliate targeting are off regardless of what any toggle says.
   */
  minor: boolean;
}

export const DEFAULT_PRIVACY: PrivacySnapshot = {
  analytics: false,
  memory: false,
  marketing: false,
  telemetry: false,
  minor: false,
};

const STORAGE_KEY = "aksharo.privacy";

type Listener = (snapshot: PrivacySnapshot) => void;

const listeners = new Set<Listener>();

function parse(raw: string | null): PrivacySnapshot {
  if (raw === null) return DEFAULT_PRIVACY;
  try {
    const parsed = JSON.parse(raw) as Partial<PrivacySnapshot>;
    return {
      analytics: parsed.analytics === true,
      memory: parsed.memory === true,
      marketing: parsed.marketing === true,
      telemetry: parsed.telemetry === true,
      minor: parsed.minor === true,
    };
  } catch {
    return DEFAULT_PRIVACY;
  }
}

export function readPrivacy(): PrivacySnapshot {
  if (typeof window === "undefined") return DEFAULT_PRIVACY;
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled. Defaulting to "no" is the safe answer.
    return DEFAULT_PRIVACY;
  }
}

export function writePrivacy(update: Partial<PrivacySnapshot>): PrivacySnapshot {
  const next = { ...readPrivacy(), ...update };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Nothing to do: the server still has the record, and analytics simply
      // stays off for this browser.
    }
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function subscribePrivacy(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether product analytics may run at all (D60 overrides the toggle). */
export function analyticsAllowed(snapshot: PrivacySnapshot = readPrivacy()): boolean {
  return snapshot.analytics && !snapshot.minor;
}

/** The consent payload the API expects, from the toggles a form collected. */
export function toConsents(
  snapshot: Pick<PrivacySnapshot, "analytics" | "memory" | "marketing">,
): Consents {
  return {
    analytics: snapshot.analytics,
    memory: snapshot.memory,
    marketing: snapshot.marketing,
  };
}
