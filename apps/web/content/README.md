# `apps/web/content` — Academy, Help centre, Changelog (B12)

MDX collections, one directory per collection: `academy/`, `help/`,
`changelog/`. Frontmatter is YAML, parsed with `gray-matter` and validated
against the zod schemas in `apps/web/lib/content/schema.ts`
(`AcademyTrackFrontmatterSchema`, `HelpArticleFrontmatterSchema`,
`ChangelogFrontmatterSchema`) by `apps/web/lib/content/loader.ts`.

**Invalid frontmatter fails the build.** `loader.ts` throws synchronously the
first time a bad file is parsed; `lib/content/content.schema.test.ts` exercises
every file in CI, so a mistake is a red test, not a broken production page.

## Adding an Academy track

Create `apps/web/content/academy/<track-id>.mdx` with frontmatter matching
`AcademyTrackFrontmatterSchema` (id, title, outcome, category, order,
demoVideoAssetId, creditReward ≤ 25, steps[]) and Markdown body below the
`---` fence. Then mirror the same id/steps/`completionEvent`/`creditReward`
into `apps/api/src/academy/academy.catalog.ts` — see that file's own doc
comment for why the API keeps its own copy rather than reading this
directory.

## Adding a Help article

`apps/web/content/help/<slug>.mdx`, frontmatter matching
`HelpArticleFrontmatterSchema` (slug, title, category, helpSlug, order,
summary). `helpSlug` is what the editor's contextual help links reference —
usually equal to `slug`, kept distinct so a URL slug can change independently.
The build-time MiniSearch index (`apps/web/lib/content/search.ts`) indexes
`title`, `summary` and `body`.

## Adding a Changelog entry

`apps/web/content/changelog/<version>.mdx`, frontmatter matching
`ChangelogFrontmatterSchema` (version as semver `x.y.z`, date as `YYYY-MM-DD`,
title, tags[]). The newest `date` is "the current version" for the What's-new
modal (`GET /api/changelog/latest`, `components/academy/whats-new-modal.tsx`).

## Rendering

Body Markdown is rendered by `apps/web/lib/content/markdown.tsx` — a small,
deliberately non-CommonMark renderer (headings, paragraphs, lists, fenced
code, inline bold/italic/code/links) chosen over pulling in `remark`/`rehype`/
an MDX compiler, to keep this work package's new dependencies to two small,
pure-JS libraries: `gray-matter` and `minisearch`.
