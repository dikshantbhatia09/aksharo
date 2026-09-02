"use client";

import { analyticsAllowed, readPrivacy } from "@/lib/privacy/consent";

/**
 * Product analytics, and the rule that governs it: **nothing loads before
 * consent.**
 *
 * `posthog-js` is imported dynamically, so before a user opts in the bundle is
 * not merely inert — it is not in the page at all, and there is no request to
 * any analytics host to be seen in devtools. D60 adds the second rule: a
 * declared minor never gets analytics, whatever the toggle says, so
 * `analyticsAllowed` is checked on every call rather than once at start-up.
 */

interface PostHogLike {
  init: (key: string, options: Record<string, unknown>) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (id: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
  opt_out_capturing: () => void;
}

let instance: PostHogLike | null = null;
let loading: Promise<PostHogLike | null> | null = null;

export interface AnalyticsConfig {
  key: string | null;
  host: string;
}

let config: AnalyticsConfig = { key: null, host: "" };

export function configureAnalytics(next: AnalyticsConfig): void {
  config = next;
}

async function load(): Promise<PostHogLike | null> {
  if (instance !== null) return instance;
  if (config.key === null) return null;
  if (!analyticsAllowed()) return null;

  loading ??= import("posthog-js")
    .then((module) => {
      const posthog = module.default as unknown as PostHogLike;
      posthog.init(config.key ?? "", {
        api_host: config.host,
        // The shell decides what a page view is; automatic capture would send
        // one from every route the user is redirected through mid-sign-in.
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        disable_session_recording: true,
        persistence: "localStorage",
        // Addresses and names are personal data and never belong in an event.
        property_denylist: ["$email", "email", "name", "$ip"],
        mask_all_text: true,
      });
      instance = posthog;
      return posthog;
    })
    .catch(() => null);

  return loading;
}

/** Record an event, if — and only if — analytics is allowed right now. */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!analyticsAllowed()) return;
  void load().then((posthog) => {
    posthog?.capture(event, properties);
  });
}

/** Associate events with a user id. Never send the address (07 §Privacy). */
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!analyticsAllowed()) return;
  void load().then((posthog) => {
    posthog?.identify(userId, properties);
  });
}

/** Called on sign-out and whenever consent is withdrawn. */
export function resetAnalytics(): void {
  instance?.opt_out_capturing();
  instance?.reset();
}

/** Load now if consent already exists; otherwise do nothing. */
export function initAnalyticsIfConsented(): void {
  if (!analyticsAllowed(readPrivacy())) return;
  void load();
}

/** Test seam: forget the loaded module. */
export function __resetAnalyticsForTests(): void {
  instance = null;
  loading = null;
  config = { key: null, host: "" };
}
