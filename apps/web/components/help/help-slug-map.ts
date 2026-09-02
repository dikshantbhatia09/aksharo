/**
 * Contextual help links from the editor panels (brief §4: "ids referenced
 * from the UI via a help-slug map"). A panel imports {@link helpUrlFor} and
 * links to it by a stable id — the same `helpSlug` every Help article's
 * frontmatter declares (`apps/web/lib/content/schema.ts`) — so a panel never
 * hard-codes a `/help/<slug>` URL that breaks the moment an article's URL
 * slug changes.
 *
 * **Wiring into the editor panels themselves is out of this work package's
 * file boundary** (`apps/web/components/editor/**` is other work packages'
 * territory) — this module is the seam other panels are expected to import
 * from, the same "not wired into a page" shape `ReferralPromptSheet` and
 * `WhatsNewModal` document for their own mount points. Flagged as an open
 * item in the final report: which panel gets which `helpSlug` is a product
 * decision for whichever WP owns that panel to make.
 */
export const HELP_SLUGS = [
  "upload-media",
  "transcript-edit",
  "caption-styles",
  "emphasis-timing",
  "export-project",
  "credits-plans",
  "account-devices",
  "plugins-overview",
  "brand-kits",
  "job-stuck",
] as const;

export type HelpSlug = (typeof HELP_SLUGS)[number];

export function isHelpSlug(value: string): value is HelpSlug {
  return (HELP_SLUGS as readonly string[]).includes(value);
}

/**
 * `/help/{slug}` for a given contextual-help id. Every seed article's URL
 * `slug` equals its `helpSlug` (`content.schema.test.ts` does not enforce
 * this — it is a content convention, not a schema rule), so this is a plain
 * lookup rather than a query against the loader; if an article's URL slug
 * ever needs to diverge from its `helpSlug`, resolve it through
 * `getHelpArticleByHelpSlug` (`lib/content/loader.ts`, server-only) instead.
 */
export function helpUrlFor(helpSlug: HelpSlug): string {
  return `/help/${helpSlug}`;
}
