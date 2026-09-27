/**
 * Operations settings the API reads straight from `process.env`.
 *
 * Not in `@montaj/config`'s validated `Env`, for the reason `queuePrefix()` and
 * `MONTAJ_SCHEDULER_DISABLED` are not: CONTRACTS §1 is the frozen list of
 * *product* configuration, and where this deployment's alerts go is operations
 * wiring. The scheduler's own `MONTAJ_SCHEDULER_TASKS` lives next to its kill
 * switch in `common/scheduler/scheduler.types.ts`.
 *
 * Nothing here throws. A malformed alert destination must not stop the API
 * from booting — the site matters more than the pager — so it degrades to
 * "log only" and says so once, at boot, without echoing the value.
 */

/** Why an `ALERT_WEBHOOK_URL` was not used. The value itself is never repeated. */
export type AlertWebhookProblem = "not_a_url" | "insecure" | "has_credentials";

export type AlertWebhookSetting =
  | { readonly kind: "unset" }
  | { readonly kind: "invalid"; readonly problem: AlertWebhookProblem }
  | { readonly kind: "ok"; readonly url: URL };

/** Hosts an alert may be posted to over plain HTTP: this machine only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `ALERT_WEBHOOK_URL`: the ntfy topic URL operational alerts are POSTed to
 * (owner decision 2026-09-27), e.g. `https://ntfy.sh/<topic>`.
 *
 * - **https only**, except to a loopback host (a self-hosted ntfy on this
 *   machine). An ntfy topic is a bearer secret — anyone who knows it can read
 *   it — so it does not travel in clear over a network.
 * - **No `user:password@`**: credentials in a URL end up in whatever logs the
 *   URL, and the sender never logs it but a proxy might.
 */
export function alertWebhookSetting(source: NodeJS.ProcessEnv = process.env): AlertWebhookSetting {
  const raw = source["ALERT_WEBHOOK_URL"]?.trim();
  if (raw === undefined || raw === "") return { kind: "unset" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", problem: "not_a_url" };
  }
  if (url.username !== "" || url.password !== "") {
    return { kind: "invalid", problem: "has_credentials" };
  }
  if (url.protocol === "https:") return { kind: "ok", url };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { kind: "ok", url };
  return { kind: "invalid", problem: url.protocol === "http:" ? "insecure" : "not_a_url" };
}
