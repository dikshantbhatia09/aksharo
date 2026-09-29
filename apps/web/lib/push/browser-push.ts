/**
 * This browser's side of Web Push (2026-09-29): whether it can, the service
 * worker that shows the notifications (`public/sw.js`), and its subscription.
 *
 * Nothing here asks for permission. The one place that does is the settings
 * toggle, on a click — a permission prompt the person did not ask for is how a
 * site gets blocked for good.
 */
import type { PushSubscriptionRequest } from "@montaj/api-client";

/** The service worker's path and scope: the whole app, so a click can open any page. */
export const SERVICE_WORKER_URL = "/sw.js";
const SCOPE = "/";

/** Service workers, the Push API and notifications, all three. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** A base64url VAPID key as the bytes `applicationServerKey` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Whether `subscription` was made with `publicKey` (a rotated key makes it useless). */
export function subscribedWith(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  const expected = keyBytes(publicKey);
  const actual = new Uint8Array(current);
  return (
    actual.length === expected.length && actual.every((byte, index) => byte === expected.at(index))
  );
}

/** The subscription as the API takes it: `toJSON()`, keys and all. */
export function subscriptionBody(subscription: PushSubscription): PushSubscriptionRequest {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.["p256dh"] ?? "", auth: json.keys?.["auth"] ?? "" },
  };
}

/** This browser's subscription, if it has one; never registers anything. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SCOPE);
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

/**
 * Register the service worker and subscribe with `publicKey`, replacing a
 * subscription made with another key. The caller has permission already.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<PushSubscription> {
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SCOPE });
  // A subscription needs an ACTIVE worker, which a first registration is not
  // yet; `ready` waits for it.
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null && subscribedWith(existing, publicKey)) return existing;
  if (existing !== null) await existing.unsubscribe();
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
}
