/**
 * Navigation / window.open / shell.openExternal allowlists (brief §1, §2;
 * THREAT-MODEL T10 "malicious page takes over the desktop shell", T24
 * "desktop preload leaks privileged APIs to arbitrary origins").
 *
 * Pure, dependency-free so it can be unit tested without an Electron runtime.
 * `src/main/index.ts` and `src/preload/index.ts` are the only callers.
 */
import { BRAND } from "@montaj/config/brand";

/** The hosted web app the main window loads (decision D71). */
export const APP_ORIGIN = `https://app.${BRAND.domain}`;
/** Secondary domain, kept allowed for redirects during the brand's dual-domain period. */
export const ALT_APP_ORIGIN = `https://app.${BRAND.altDomain}`;

/** OAuth / payment origins the app must be able to navigate a *sub*-window to. */
export const GOOGLE_OAUTH_ORIGINS = ["https://accounts.google.com"];
export const RAZORPAY_ORIGINS = ["https://checkout.razorpay.com", "https://api.razorpay.com"];

/** Origins the main window itself may navigate to (top-level `did-navigate`). */
export const MAIN_WINDOW_NAVIGATION_ALLOWLIST: readonly string[] = [
  APP_ORIGIN,
  ALT_APP_ORIGIN,
  ...GOOGLE_OAUTH_ORIGINS,
];

/**
 * Origins that may be opened in a new, tightly-scoped BrowserWindow via
 * `window.open` / `setWindowOpenHandler` — auth hand-offs and the Razorpay
 * checkout overlay. Everything else is routed to the OS browser (or denied).
 */
export const CONTROLLED_POPUP_ALLOWLIST: readonly string[] = [
  ...GOOGLE_OAUTH_ORIGINS,
  ...RAZORPAY_ORIGINS,
];

/**
 * Origins `shell.openExternal` may hand to the OS default browser. Deliberately
 * narrower than "any https URL" — an attacker-controlled page inside the app
 * webview should not be able to make the desktop app launch an arbitrary
 * external handler (THREAT-MODEL T10).
 */
export const OPEN_EXTERNAL_ALLOWLIST: readonly string[] = [
  APP_ORIGIN,
  ALT_APP_ORIGIN,
  `https://${BRAND.domain}`,
  `https://${BRAND.altDomain}`,
  ...GOOGLE_OAUTH_ORIGINS,
  ...RAZORPAY_ORIGINS,
];

function parseOrigin(rawUrl: string): URL | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function originMatches(url: URL, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    const allowed = parseOrigin(entry);
    return allowed !== null && url.origin === allowed.origin;
  });
}

/** True if the *main window* may top-level-navigate to `rawUrl`. */
export function isNavigationAllowed(rawUrl: string): boolean {
  const url = parseOrigin(rawUrl);
  if (!url) return false;
  return originMatches(url, MAIN_WINDOW_NAVIGATION_ALLOWLIST);
}

export type PopupDecision = "controlled-window" | "external-browser" | "deny";

/** Decides how a `window.open()` call from the loaded web app should be handled. */
export function decidePopup(rawUrl: string): PopupDecision {
  const url = parseOrigin(rawUrl);
  if (!url) return "deny";
  if (originMatches(url, CONTROLLED_POPUP_ALLOWLIST)) return "controlled-window";
  if (originMatches(url, OPEN_EXTERNAL_ALLOWLIST)) return "external-browser";
  return "deny";
}

/** True if `shell.openExternal(rawUrl)` may proceed. */
export function isOpenExternalAllowed(rawUrl: string): boolean {
  const url = parseOrigin(rawUrl);
  if (!url) return false;
  return originMatches(url, OPEN_EXTERNAL_ALLOWLIST);
}
