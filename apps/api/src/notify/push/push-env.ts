import { BRAND } from "@montaj/config";

import { PushKeyError, vapidKeysFrom } from "./web-push.crypto.js";

import type { VapidKeys } from "./web-push.crypto.js";

/**
 * Web Push settings, read straight from `process.env` (2026-09-29).
 *
 * Not in `@montaj/config`'s validated `Env`, for the reason `ALERT_WEBHOOK_URL`
 * is not (`config/ops-env.ts`): CONTRACTS §1 is the frozen list of product
 * configuration, and whether this deployment can reach browsers is wiring.
 *
 *   * `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY`: this server's
 *     VAPID pair, base64url (`node apps/api/scripts/generate-vapid-keys.mjs`).
 *     Both unset is "push is off": the settings toggle says so and nothing
 *     else changes. Rotating the pair orphans every subscription made with the
 *     old one — browsers must subscribe again — so it is generated once.
 *   * `WEB_PUSH_SUBJECT`: how a push service can reach the sender, `mailto:`
 *     or `https:` (RFC 8292 §2.1). Apple refuses a token without one, so unset
 *     falls back to the support address rather than to none.
 *
 * Nothing here throws: a malformed key must not stop the API from booting —
 * the site matters more than the notifications — so it degrades to "off" and
 * the channel says so once, at boot, without echoing the value.
 */

export type WebPushProblem = "half_configured" | "bad_keys" | "bad_subject";

export type WebPushSetting =
  | { readonly kind: "off" }
  | { readonly kind: "invalid"; readonly problem: WebPushProblem }
  | {
      readonly kind: "on";
      readonly keys: VapidKeys;
      /** The public key as browsers take it (`applicationServerKey`). */
      readonly publicKey: string;
      readonly subject: string;
    };

/** `mailto:someone@host` or an `https:` URL, as RFC 8292 §2.1 allows. */
export function isVapidSubject(value: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function webPushSetting(source: NodeJS.ProcessEnv = process.env): WebPushSetting {
  const publicKey = source["WEB_PUSH_VAPID_PUBLIC_KEY"]?.trim() ?? "";
  const privateKey = source["WEB_PUSH_VAPID_PRIVATE_KEY"]?.trim() ?? "";
  if (publicKey === "" && privateKey === "") return { kind: "off" };
  if (publicKey === "" || privateKey === "") return { kind: "invalid", problem: "half_configured" };

  const subject = source["WEB_PUSH_SUBJECT"]?.trim() || `mailto:${BRAND.supportEmail}`;
  if (!isVapidSubject(subject)) return { kind: "invalid", problem: "bad_subject" };

  try {
    return { kind: "on", keys: vapidKeysFrom(publicKey, privateKey), publicKey, subject };
  } catch (error) {
    if (error instanceof PushKeyError) return { kind: "invalid", problem: "bad_keys" };
    throw error;
  }
}
