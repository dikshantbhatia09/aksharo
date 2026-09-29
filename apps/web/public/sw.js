/*
 * The web app's service worker: device notifications, and nothing else
 * (2026-09-29).
 *
 * It caches nothing and intercepts no request, on purpose: every page and
 * every API call goes to the network exactly as it did before it existed.
 * Registered by Settings > Notifications, only when the person turns "Notify me
 * on this device" on (`lib/push/browser-push.ts`).
 *
 * A push arrives encrypted to this browser's own keys (RFC 8291); the browser
 * decrypts it before `push` fires, so `event.data` is the API's JSON:
 * `{ title, body, url, tag, kind }` (`apps/api/src/notify/push/push.channel.ts`).
 * A click opens `url` — this app's own pages only — focusing a tab that is
 * already on it rather than opening a second one.
 */
"use strict";

self.addEventListener("install", () => {
  // Nothing to set up: take over from any older copy straight away.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** A URL on this app, or the app's home page for anything else. */
function sameOriginUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin ? url.href : `${self.location.origin}/`;
  } catch {
    return `${self.location.origin}/`;
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === "string" && payload.title !== "" ? payload.title : "New update";
  const tag = typeof payload.tag === "string" && payload.tag !== "" ? payload.tag : undefined;
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    data: { url: sameOriginUrl(payload.url) },
    // One notification per run: news about the same run replaces the last
    // one instead of stacking, and still buzzes.
    ...(tag === undefined ? {} : { tag, renotify: true }),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
