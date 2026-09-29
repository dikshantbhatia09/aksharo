/**
 * Which push endpoints this server will POST to (2026-09-29).
 *
 * A subscription's endpoint is a URL the BROWSER hands us, and delivering a
 * notification is this API making a request to it. Taken as given, that is a
 * way to make the API — which runs on the same laptop as the database, Redis
 * and the object store — send requests to any address a caller names: an
 * internal port, a cloud metadata address, someone else's server. So an
 * endpoint must be `https:` on the default port at one of the browser vendors'
 * own push services, and a delivery never follows a redirect (`push.channel.ts`).
 *
 * The list is every push service a browser we support subscribes through. A
 * browser that uses another one cannot turn notifications on, and says so; it
 * is added here when it is real, not guessed at.
 */

const PUSH_SERVICES: readonly { readonly host: string; readonly subdomains: boolean }[] = [
  // Chrome (desktop and Android), Opera, Samsung Internet, Brave with Google push.
  { host: "fcm.googleapis.com", subdomains: false },
  // Firefox: updates.push.services.mozilla.com.
  { host: "push.services.mozilla.com", subdomains: true },
  // Edge on Windows: wns2-*.notify.windows.com.
  { host: "notify.windows.com", subdomains: true },
  // Safari 16+ on macOS and iOS: web.push.apple.com.
  { host: "push.apple.com", subdomains: true },
];

/** Longer than any vendor's endpoint; the unique index stays well inside a btree page. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2_048;

export type PushEndpointProblem = "too_long" | "not_a_url" | "insecure" | "unknown_service";

function knownService(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PUSH_SERVICES.some((service) =>
    service.subdomains
      ? host === service.host || host.endsWith(`.${service.host}`)
      : host === service.host,
  );
}

/** Why `endpoint` may not be pushed to, or null when it may. */
export function pushEndpointProblem(endpoint: string): PushEndpointProblem | null {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return "too_long";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return "insecure";
  }
  return knownService(url.hostname) ? null : "unknown_service";
}
