/**
 * The Postiz settings the API reads straight from `process.env` (2026-09-29).
 *
 * Not in `@montaj/config`'s validated `Env`, for the reason `ALERT_WEBHOOK_URL`
 * is not (`config/ops-env.ts`): CONTRACTS §1 is the frozen list of product
 * configuration, and which publishing service this deployment talks to is
 * operations wiring. Nothing here throws - a bad value must not stop the API
 * from booting - and nothing here is ever logged back: the key is a bearer
 * secret for every social account connected in Postiz.
 *
 * - `POSTIZ_API_KEY`: the Public API key from Postiz, Settings → Developers.
 *   Absent means publishing is not set up, and says so.
 * - `POSTIZ_API_URL`: where the Public API lives. Default
 *   `http://127.0.0.1:4007/api` (the bundled Docker image serves its API under
 *   `/api` on the frontend's port); `/public/v1/...` is appended per call.
 * - `POSTIZ_APP_URL`: where a person opens Postiz to connect accounts, shown on
 *   the settings page. Default: the API URL without its trailing `/api`.
 * - `POSTIZ_WORKSPACE_IDS`: the Aksharo workspaces allowed to post through
 *   this Postiz. One Postiz organisation holds ONE set of social accounts, and
 *   the `publishing_postiz` flag alone would hand them to every workspace it is
 *   switched on for (an env override of `true` switches it on for everyone). So
 *   nobody posts unless named here too.
 * - `PUBLISH_WORKER_ENABLED`: `0` stops this process from dispatching and
 *   reconciling posts (the routes still answer). On by default, and only ever
 *   running when a key is set.
 */

export const POSTIZ_API_KEY_ENV = "POSTIZ_API_KEY";
export const POSTIZ_API_URL_ENV = "POSTIZ_API_URL";
export const POSTIZ_APP_URL_ENV = "POSTIZ_APP_URL";
export const POSTIZ_WORKSPACE_IDS_ENV = "POSTIZ_WORKSPACE_IDS";
export const PUBLISH_WORKER_ENABLED_ENV = "PUBLISH_WORKER_ENABLED";

export const DEFAULT_POSTIZ_API_URL = "http://127.0.0.1:4007/api";

/** What the owner's machine runs Postiz on (its bundled image, `FRONTEND_URL`). */
export const DEFAULT_POSTIZ_APP_URL = "http://localhost:4007";

/** Why a Postiz URL was not used. The value itself is never repeated. */
export type PostizUrlProblem = "not_a_url" | "insecure" | "has_credentials";

export type PostizSetting =
  | { readonly kind: "unset" }
  | { readonly kind: "invalid"; readonly problem: PostizUrlProblem }
  | {
      readonly kind: "ok";
      /** No trailing slash; `/public/v1/...` is appended per call. */
      readonly apiUrl: string;
      readonly apiKey: string;
      /** Where a person opens Postiz, for the settings page. */
      readonly appUrl: string;
    };

/** Hosts the API key may travel to over plain HTTP: this machine only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkUrl(raw: string): { readonly url: URL } | { readonly problem: PostizUrlProblem } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "not_a_url" };
  }
  // Credentials in a URL end up in whatever logs the URL.
  if (url.username !== "" || url.password !== "") return { problem: "has_credentials" };
  if (url.protocol === "https:") return { url };
  // The key is a bearer secret for every connected account: plain HTTP only to
  // a Postiz on this same machine, never across a network.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { url };
  return { problem: url.protocol === "http:" ? "insecure" : "not_a_url" };
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function postizSetting(source: NodeJS.ProcessEnv = process.env): PostizSetting {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const apiKey = (source[POSTIZ_API_KEY_ENV] ?? "").trim();
  // eslint-disable-next-line security/detect-possible-timing-attacks -- an empty-string sentinel, not a secret comparison
  if (apiKey === "") return { kind: "unset" };

  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const givenApi = (source[POSTIZ_API_URL_ENV] ?? "").trim();
  const api = checkUrl(givenApi || DEFAULT_POSTIZ_API_URL);
  if ("problem" in api) return { kind: "invalid", problem: api.problem };
  const apiUrl = withoutTrailingSlash(`${api.url.origin}${api.url.pathname}`);

  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const rawApp = (source[POSTIZ_APP_URL_ENV] ?? "").trim();
  // The default API address is 127.0.0.1, but Postiz's sign-in cookie is for
  // `localhost` (its FRONTEND_URL), so the default page link says localhost.
  let appUrl = givenApi === "" ? DEFAULT_POSTIZ_APP_URL : apiUrl.replace(/\/api$/, "");
  if (rawApp !== "") {
    const app = checkUrl(rawApp);
    // A bad link on the settings page is not worth refusing publishing over.
    if ("url" in app) appUrl = withoutTrailingSlash(app.url.toString());
  }
  return { kind: "ok", apiUrl, apiKey, appUrl };
}

/**
 * Where to open Postiz, even before a key is set - the settings page needs it
 * to say where the key comes from. `POSTIZ_APP_URL`, else the API URL without
 * `/api`, else the bundled image's `http://localhost:4007` (`localhost`, not
 * `127.0.0.1`: Postiz's sign-in cookie is set for its `FRONTEND_URL` host).
 */
export function postizAppUrl(source: NodeJS.ProcessEnv = process.env): string {
  const setting = postizSetting(source);
  if (setting.kind === "ok") return setting.appUrl;
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const rawApp = (source[POSTIZ_APP_URL_ENV] ?? "").trim();
  if (rawApp !== "") {
    const app = checkUrl(rawApp);
    if ("url" in app) return withoutTrailingSlash(app.url.toString());
  }
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const rawApi = (source[POSTIZ_API_URL_ENV] ?? "").trim();
  if (rawApi !== "") {
    const api = checkUrl(rawApi);
    if ("url" in api) {
      return withoutTrailingSlash(`${api.url.origin}${api.url.pathname}`).replace(/\/api$/, "");
    }
  }
  return DEFAULT_POSTIZ_APP_URL;
}

/** The workspaces allowed to post through this Postiz, deduplicated. */
export function postizWorkspaceIds(source: NodeJS.ProcessEnv = process.env): readonly string[] {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = source[POSTIZ_WORKSPACE_IDS_ENV] ?? "";
  return [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    ),
  ];
}

/** Whether this process dispatches and reconciles posts (default on). */
export function publishWorkerEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = (source[PUBLISH_WORKER_ENABLED_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}
