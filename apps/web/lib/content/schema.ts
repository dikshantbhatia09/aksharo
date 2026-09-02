import { z } from "zod";

/**
 * Frontmatter schemas for the three MDX collections this work package owns
 * (`apps/web/content/{academy,help,changelog}`). `loadCollection` in
 * `loader.ts` parses every file's frontmatter with these and throws — failing
 * the build — on the first invalid one, per the brief's "invalid frontmatter
 * fails the build".
 *
 * Slugs, step ids and category are plain kebab-case strings because they are
 * used verbatim as `academy_progress.step_id` / URL segments / the help-slug
 * map the editor panels reference — no free-text spaces or punctuation that
 * would need escaping there.
 */
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = z.string().regex(slugPattern, "must be kebab-case (a-z, 0-9, hyphen)");

export const ACADEMY_CATEGORIES = ["reels", "podcasts", "editors", "agency"] as const;
export type AcademyCategory = (typeof ACADEMY_CATEGORIES)[number];

/** Product events that can auto-complete a step (A08's event bus, CONTRACTS §7-adjacent). */
export const ACADEMY_COMPLETION_EVENTS = ["export.completed"] as const;
export type AcademyCompletionEvent = (typeof ACADEMY_COMPLETION_EVENTS)[number];

export const AcademyStepSchema = z.object({
  id: slug,
  title: z.string().min(1).max(120),
  /** What the learner does — rendered under the step title. */
  detail: z.string().min(1).max(500),
  /** A product event that marks this step done automatically; omit for "Mark done" only. */
  completionEvent: z.enum(ACADEMY_COMPLETION_EVENTS).optional(),
});
export type AcademyStep = z.infer<typeof AcademyStepSchema>;

export const AcademyTrackFrontmatterSchema = z.object({
  id: slug,
  title: z.string().min(1).max(160),
  /** The outcome promise shown on the tracks list, e.g. "Ship a ... in 10 minutes". */
  outcome: z.string().min(1).max(240),
  category: z.enum(ACADEMY_CATEGORIES),
  order: z.number().int().min(0),
  /** Placeholder asset id for the embedded demo video — B15/media resolves it. */
  demoVideoAssetId: slug,
  /** Credits granted once, on first full completion. Capped 25/track (brief §2). */
  creditReward: z.number().int().min(0).max(25),
  steps: z.array(AcademyStepSchema).min(1),
});
export type AcademyTrackFrontmatter = z.infer<typeof AcademyTrackFrontmatterSchema>;

export interface AcademyTrack extends AcademyTrackFrontmatter {
  readonly body: string;
}

export const HELP_CATEGORIES = [
  "getting-started",
  "editing",
  "captions-and-styles",
  "exporting",
  "billing-and-credits",
  "account-and-privacy",
  "plugins",
  "troubleshooting",
] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

export const HelpArticleFrontmatterSchema = z.object({
  slug,
  title: z.string().min(1).max(160),
  category: z.enum(HELP_CATEGORIES),
  /**
   * The id contextual help links in the editor pass (`help-slug map`, brief
   * §4) — usually the same as `slug`, but kept distinct so a URL slug can
   * change without breaking every panel that links to it.
   */
  helpSlug: slug,
  order: z.number().int().min(0),
  summary: z.string().min(1).max(240),
});
export type HelpArticleFrontmatter = z.infer<typeof HelpArticleFrontmatterSchema>;

export interface HelpArticle extends HelpArticleFrontmatter {
  readonly body: string;
}

export const ChangelogFrontmatterSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver x.y.z"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  title: z.string().min(1).max(160),
  /** Short tags shown as pills, e.g. ["academy", "support"]. */
  tags: z.array(z.string().min(1).max(24)).default([]),
});
export type ChangelogFrontmatter = z.infer<typeof ChangelogFrontmatterSchema>;

export interface ChangelogEntry extends ChangelogFrontmatter {
  readonly body: string;
}
