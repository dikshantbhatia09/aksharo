/**
 * The ONLY place brand strings are allowed to live (docs/CONTRACTS.md §0).
 *
 * `montaj` is the internal engineering codename: repository folder, `@montaj/*`
 * package scope and BullMQ queue names. It must never reach UI copy, domains,
 * bundle ids, plugin ids, installer names, OAuth client names or marketing.
 * A rename after the legal review touches this file plus DNS.
 *
 * **Do not put a competitor's name here.** The Sep-2026 visual-parity work
 * (matching the editor chrome of a competitor product) overwrote this file with
 * that competitor's name, domain, deep-link scheme and support address, which
 * would have shipped their trademark as our own brand and pointed support mail
 * and the desktop deep link at a domain we do not control. Parity is a *visual*
 * exercise; brand strings are decision D59 (CONTRACTS §0) and change only by ADR.
 * {@link FORBIDDEN_BRAND_NAMES} makes the regression a failing test, not a review
 * catch.
 */

/**
 * Names that must never appear in {@link BRAND}: other companies' products whose
 * look-and-feel this codebase deliberately studies. Lower-cased for comparison.
 */
export const FORBIDDEN_BRAND_NAMES = ["kalakar", "montaj"] as const;

export const BRAND = {
  name: "Aksharo",
  domain: "aksharo.ai",
  altDomain: "aksharo.in",
  deepLinkScheme: "aksharo",
  supportEmail: "support@aksharo.ai",
} as const;

export type Brand = typeof BRAND;

/** Internal codename. Never render this to a user. */
export const CODENAME = "montaj" as const;

/**
 * Host-app extension identifiers (CONTRACTS §0). They are brand-derived, so they
 * belong here rather than in each plugin manifest.
 */
export const PLUGIN_IDS = {
  premiereUxp: "ai.aksharo.panel",
  afterEffectsCep: "ai.aksharo.ae",
  resolveScript: "aksharo_core",
} as const;

export type PluginId = (typeof PLUGIN_IDS)[keyof typeof PLUGIN_IDS];

/** Canonical https origin for the marketing site and the studio. */
export function brandUrl(path = "/"): string {
  return new URL(path, `https://${BRAND.domain}`).toString();
}

/** Deep link into the desktop app, e.g. `aksharo://project/01J...`. */
export function deepLink(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${BRAND.deepLinkScheme}://${trimmed}`;
}
