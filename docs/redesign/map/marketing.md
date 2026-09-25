# Map: public marketing site and docs

Owner area: `apps/web/app/(site)/(marketing)/**` and `apps/web/content/**`.
Audited against `docs/redesign/DESIGN.md` (Shirorekha) and the Apple HIG pages
at `~/.claude/skills/apple-design/references/hig/`. It's a web app, so the
audit applies the HIG's foundations (accessibility, layout, typography, colour,
writing, buttons, segmented controls) and not iOS/macOS-only conventions.

Line numbers in the findings point to the code as it was **before** this pass
(commit `0d5e1df0`).

## Measured contrast (WCAG 2.x, computed from the token hexes)

| Pair | Ratio | Verdict |
|---|---|---|
| `fg-0` #f1ece6 on `bg-0` #141217 | 15.84 | pass |
| `fg-1` #d6cfc8 on `bg-0` | 12.07 | pass |
| `fg-2` #a39a93 on `bg-0` / `surface` / `bg-2` | 6.73 / 6.09 / 5.37 | pass |
| `accent` #f0508a on `bg-0` / `surface` / `bg-2` | 5.51 / 4.98 / **4.39** | fails on `bg-2` (use `accent-300`, 6.55) |
| ink on `accent` (primary button) | 5.51 | pass |
| `fg-0` / `neutral-200` / `fg-1` / `fg-2` on `section` #3a1427 (stat band) | 13.66 / 12.84 / 10.40 / 5.81 | pass |
| `accent-200` on `accent/16` over `bg-0` (old hero toggle) | 10.73 | pass, but uses up the accent budget |
| `fg-0` on `warning/10` over `bg-0` (legal draft banner) | 13.35 | pass |
| `border` #36313a on `bg-0` (non-text) | 1.47 | decorative hairline only; never the only boundary of a control |

Contrast was mostly fine. The problems were hierarchy, the accent budget, hit
targets and type.

## Shared chrome

### Marketing layout — `layout.tsx`
- **Job:** wraps every marketing and docs page in the header, a skip link and the footer.
- **Renders:** `SiteHeader`, `<main id="main">`, `SiteFooter`.
- **Reached from:** every public URL except the auth pages.
- Audit: the skip link and landmark are correct. No findings.

### Header — `_components/site-header.tsx`
- **Job:** brand, primary nav, sign in, start free.
- **Reached from:** every marketing page.
- **High:** the header's "Start free" was `variant="primary"` (`site-header.tsx:78`) on every page, so each page with its own CTA had two filled primaries on screen (home had three). HIG buttons.md › Style: "Keep the number of prominent buttons to one or two per view". DESIGN.md › Components says once per surface.
- **Medium:** desktop nav links had no hit area beyond the text glyphs (`:64`), about 20 px tall. HIG buttons.md › Best practices (hit region); DESIGN.md › Accessibility floor (32 px).
- **Medium:** the active nav item was shown only by a change in text colour (`:65`). HIG accessibility.md › Vision: "Convey information with more than color alone".
- **Medium:** the wordmark used `font-display` (`:45`). DESIGN.md › Type limits the display face to page titles, the hero and stat figures.
- **Low:** the header used `backdrop-blur` over content (`:40`). DESIGN.md › Shape: glass and blur only on floating chrome. A sticky bar that is fully opaque doesn't need it.
- **Low:** mobile menu rows were about 36 px (`:107`) and the menu toggle was 40 px. That's under 44 px on a touch layout (DESIGN.md › Accessibility floor).

### Footer — `_components/site-footer.tsx`
- **Job:** legal links, grievance contact, attribution, copyright.
- **Medium:** footer links had about 20 px targets (`:36`). Judgment, plus DESIGN.md 32 px floor.
- **Medium:** the brand name used `font-display` (`:54`) (DESIGN.md › Type).
- **Low:** section labels were uppercase with letter-spacing (`:32`), which breaks the sentence-case rule. HIG writing.md › Best practices: "Adopt capitalization rules … apply them consistently".

### OpenGraph image — `_components/og-template.tsx` (and the five `opengraph-image.tsx` files)
- **Job:** the 1200 × 630 social card for home, features, pricing, plugins and styles.
- **High:** every literal was a Nocturne hex (`#161826`, `#9184d9`, `#cfd3e5`; `:26-40`), so the social card showed the retired blue-grey and blurple palette.
- **Medium:** a radial-gradient "bloom" (`:27`). DESIGN.md › Accent budget: no gradients.
- **Low:** the brand name was set in accent text. It's now the only accent on the card, drawn as the shirorekha bar.

## Routes

### `/` (home) — `page.tsx`, `_components/home-hero.tsx`, `_components/live-caption-demo.tsx`
- **Job:** show a first-time visitor what Aksharo does with their speech, and get them to start free.
- **Reached from:** search, social cards, the header wordmark.
- **Critical:** the page had no shirorekha title. The hero `<h1>` was hand-rolled (`home-hero.tsx:52`), so the system's one signature was missing from its most-seen page.
- **High:** three filled primaries: the header, the hero (`page.tsx:36`) and the closing CTA (`page.tsx:133`). HIG buttons.md › Style.
- **High:** the accent was spent as decoration: numerals on the value props (`page.tsx:101`), the selected style pill (`live-caption-demo.tsx:262`, `border-lime-500 bg-lime-500/10 text-lime-500`), the hero language toggle tint (`home-hero.tsx:41`), an accent spinner (`:230`) and a radial accent-900 gradient behind the demo (`:209`). DESIGN.md › Accent budget.
- **High:** `font-display` on the section h2s and all four value-prop h3s (`page.tsx:90,104,124`) (DESIGN.md › Type).
- **Medium:** type below the scale: 11 px, 11.5 px, 12.5 px and 13.5 px body copy (`page.tsx:43,71,76,107,128`; `home-hero.tsx:20,41`). HIG typography.md › Ensuring legibility; DESIGN.md › Type scale.
- **Medium:** hit targets of about 24 px on the hero language toggle (`home-hero.tsx:41`) and about 28 px on the demo style pills (`live-caption-demo.tsx:260`) (DESIGN.md floor 32).
- **Medium:** the Play/Pause action sat inside the "Caption style" selection group (`live-caption-demo.tsx:270`). HIG segmented-controls.md › Best practices: "Don't assign actions to segments in a control that otherwise represents selection state".
- **Medium:** `bg-black/40` overlay (`:228`), which breaks the no-`black/NN` rule, and a raw Nocturne hex as the canvas background (`:153`).
- **Medium:** the stat band's figures and labels were loose `<p>` elements with no relationship between them (`page.tsx:69-72`). A `dl` makes the label–value pairing explicit to assistive technology (HIG accessibility.md › Vision › VoiceOver).
- **Low:** the value props read as a flat list of floating text, with no container grouping each one. HIG layout.md › Visual hierarchy: "Group related items".
- Loading state: the demo shows a "transcribing" beat. It's now also announced as `role="status"` text rather than being screen-reader-only. Error state: the renderer error leaves the flat frame. Acceptable.

### `/features` — `features/page.tsx`
- **Job:** explain each value proposition in detail, with the measured-accuracy table.
- **Reached from:** header nav, footer, home "See every feature".
- **Critical:** centred hand-rolled `<h1>` with no shirorekha (`:29-31`).
- **High:** accent numerals (`text-lime-500`, `:47`) (DESIGN.md › Accent budget).
- **Medium:** a long single column with no way to jump to a section. HIG layout.md › Visual hierarchy (progressive disclosure, order by importance).
- **Low:** the "not yet measured" table cells were italic (`:79`). Italic at 14 px on dark hurts legibility (HIG typography.md › Ensuring legibility).
- **Low:** the secondary CTA used the legacy `outline` variant (`:98`).

### `/pricing` — `pricing/page.tsx`, `_components/pricing-content.tsx`, `plan-card.tsx`, `plan-matrix.tsx`, `currency-toggle.tsx`
- **Job:** show what each plan costs and what credits buy, and let a visitor start on one.
- **Reached from:** header nav, home "See pricing", footer.
- **Critical:** centred hand-rolled `<h1>` with no shirorekha (`pricing-content.tsx:55-57`).
- **High:** the selected billing, currency and script segments were **solid accent fills** (`pricing-content.tsx:96`, `currency-toggle.tsx:75`). Three accent floods sat above the plan cards, competing with the one primary. DESIGN.md › Accent budget.
- **High:** the most-popular card wore an accent border and ring (`plan-card.tsx:27`), which in this system means "selected". It also had accent "+" bullets (`:62`) and an accent badge (`:33`).
- **High:** `font-display` on five section h2s (`pricing-content.tsx:114,136,189,245,255,266`).
- **Medium:** segment buttons were about 24 px tall (`py-1 text-xs`) (DESIGN.md floor).
- **Medium:** five plan cards forced into five columns at `lg` (1024 px), about 180 px each (`:107`). HIG layout.md › Adaptability.
- **Low:** offer tiles were bare outlines with no surface (`:121`), which doesn't match the card recipe.
- Fallback state: `data-plan-source="fallback"` renders the static mirror silently. Fine for a visitor.

### `/download` — `download/page.tsx`, `_components/platform-detector.tsx`
- **Job:** give a desktop user the build for their OS and first-run steps. Only rendered when the `desktop` surface is on.
- **Critical:** centred hand-rolled `<h1>` (`:45-47`).
- **High:** up to three filled primaries, one per platform card (`:84`).
- **High:** the detected-platform banner was an accent-tinted pill (`platform-detector.tsx:29`), and it said "jump to the card below" without being a link. HIG writing.md › Best practices: "Be action oriented".
- **Medium:** first-run steps at 12 px, and italic placeholder copy (`:97,103`).

### `/plugins` — `plugins/page.tsx`
- **Job:** explain the Premiere/After Effects and Resolve panels and link their downloads. Only rendered when the `plugins` surface is on.
- **Critical:** centred hand-rolled `<h1>` (`:42-44`).
- **High:** a filled primary on each plugin download (`:86`) plus the page CTA (`:129`).
- **High:** accent step numerals (`:120`), and `font-display` on a section h2 (`:114`).
- **Medium:** the host-version and install metadata was a run-in `dl` at 12 px, `inline` (`:64-73`). It's hard to scan (HIG layout.md › Visual hierarchy: alignment).
- **Low:** the capability notes were 12 px.

### `/styles` — `styles/page.tsx`, `_components/styles-gallery-grid.tsx`
- **Job:** let a visitor browse all 30 caption styles, rendered by the real renderer.
- **Critical:** centred hand-rolled `<h1>` (`styles/page.tsx:25-27`).
- **High:** accent-filled selected script segment and category chip (`styles-gallery-grid.tsx:78,106`).
- **High:** **no empty state.** A search with no match left an empty grid under "0 of 30 styles" with no way back. HIG writing.md › Best practices: "Provide clear next steps on any blank screens".
- **Medium:** a hand-rolled `<input>` instead of the `Input` primitive (`:51`), about 36 px, not on `bg-sunken` (DESIGN.md › Components › Inputs).
- **Medium:** tile names at 12 px, controls about 24 px tall.
- **Medium:** the count didn't announce changes. It's now `aria-live="polite"` (HIG accessibility.md › Vision).
- Deferred (Medium): tiles animate on pointer hover only. The `onFocus` handler never fires because the tile isn't focusable. See Deferred.

### `/status` — `status/page.tsx`
- **Job:** tell anyone whether the service is up, and show recent incidents.
- **Critical:** the `<h1>` was the status sentence itself, with no page title or shirorekha (`:44`).
- **Critical:** "operational" was drawn in **the brand accent** (`bg-lime-500`, `:21`), and degraded/down used Tailwind stock `amber-500`/`red-500` (`:22-23`). So a signal was drawn in the brand colour, and all three states were separated only by the colour of an 8–12 px dot. HIG accessibility.md › Vision: "Convey information with more than color alone"; HIG color.md › Best practices: "Avoid using the same color to mean different things".
- **Medium:** components list had no container; incidents empty state was a bare line.

### `/changelog` — `changelog/page.tsx`
- **Job:** list what shipped, and when.
- **Critical:** hand-rolled `<h1>` (`:22`).
- **Medium:** the empty state was a centred sentence with no heading or next step (`:28-34`). HIG writing.md › Best practices (blank screens).
- **Low:** tags were `fg-2` on `bg-2`. That's 5.37:1, which passes, but it's the lowest pair on the site; raised to `fg-1`.

### `/legal`, `/legal/[slug]`, `/legal/grievance`, `/legal/sub-processors`
- **Job:** publish the draft legal documents, the grievance contact and the sub-processor list.
- **Reached from:** footer (every page), docs "Legal" card, sign-up consent links.
- **Critical:** four hand-rolled `<h1>`s (`legal/page.tsx:21`, `[slug]/page.tsx:39`, `grievance/page.tsx:19`, `sub-processors/page.tsx:28`).
- **High:** accent check marks on the privacy rights list (`[slug]/page.tsx:97`) (DESIGN.md › Accent budget: no accent icons in lists).
- **Medium:** legal index rows were underlined-on-hover text only, with a target the size of the title (`legal/page.tsx:33`). The whole row is now the link.
- **Medium:** long documents had no in-page navigation. Body copy was 14 px with no line-length limit (`[slug]/page.tsx:56`). HIG typography.md › Ensuring legibility; layout.md › Visual hierarchy.
- **Medium:** the draft banner relied on the warning hue plus bold text. It now also carries an icon (HIG accessibility.md › Vision).
- **Low:** the sub-processor table used `td` for row headers (`sub-processors/page.tsx:60`), and headers were `fg-0` semibold, heavier than the data.

### `/docs/**` — `docs/layout.tsx`, `docs-shell.tsx`, index, guides, plugins, developers
- **Job:** one docs site for creator guides, plugin guides, the public API reference and legal.
- **Reached from:** footer and in-app help, and search engines.
- **Critical:** every docs page had a hand-rolled `<h1>` (`docs/page.tsx:19`, `guides/page.tsx:40`, `guides/[slug]/page.tsx:33`, `plugins/page.tsx:30`, `plugins/[slug]/page.tsx:44`, `developers/page.tsx:50`, `[version]/page.tsx:39`, `[version]/[tag]/page.tsx:108`).
- **High:** the docs index linked to **Plugins even while the plugins surface is off** (`docs/page.tsx:26`). The sidebar (`buildDocsNav`) already filtered it, so the index offered a link that 404s (`assertServerSurfaceEnabled`). HIG writing.md › Best practices; launch-readiness P0-12.
- **High:** the sidebar's active item was **accent text at 12 px** (`docs-shell.tsx:84`), and the items had about 16 px targets (`:85`). DESIGN.md › Accent budget (the active nav row is `text-fg-0` with an accent bar); DESIGN.md › Accessibility floor.
- **Medium:** HTTP method labels were drawn in the accent (`[tag]/page.tsx:41`), and prose links used `text-accent` instead of the `link` style's `accent-300` (`plugins/page.tsx:35`, `developers/page.tsx:58,62,197`).
- **Medium:** search results were 12 px title and 11 px summary with about 28 px rows (`docs-shell.tsx:134-136`). The no-results message offered no next step (`:130`).
- **Medium:** link cards: the `<Link>` was inline around a block `Card`, so the focus ring drew around a zero-height inline box. Hover was a `shadow-sm` that is nearly invisible on dark.
- **Low:** API tables had `th` without `scope`, `border-border/50` rules, and h2s with no colour token.
- **Low:** "Edit this page" opens a new tab with no warning to assistive technology (`edit-this-page.tsx:11`).

### `apps/web/content/**`
- Data and copy only (nav, pricing, legal, hero copy, value props, docs overview, MDX help). No styling lives here. Nothing needed changing. The claim-crawl and site-content tests guard the copy, and they still pass unchanged.

## Changes made

All in owned files. Copy meaning is unchanged: no claim, price or legal
statement was reworded. The only text edits are the new empty-state headlines and
next-step links, the status page's "System status" title (the live status
sentence moved into a card under it), the new "On this page" labels, and
dropping a phrase the changelog empty state now repeats in its headline.

- **Shirorekha titles.** Every page title is now `<PageHeader>`, exactly one per page: home (`size="lg"`, with the kicker as eyebrow and the `hero-headline` test id and `lang` on a span inside the `h1`), features, pricing, download, plugins, styles, status ("System status", with the live state in a card below it), changelog, the legal index and its three pages (eyebrow "Legal"), and all eight docs pages (the docs "Edit this page" link sits in `actions`).
- **One primary per surface.** The header CTA is now `secondary` (the mobile menu sheet keeps one primary). Home keeps the hero primary and demotes the closing CTA. Pricing's only primary is the most-popular plan's CTA. Download and plugin download buttons are `secondary`. Features and plugins each keep one page CTA. Legacy `outline` variants are now `secondary`.
- **Accent floods removed.** Segmented controls (hero language, billing interval, currency, preview script) and chips (demo styles, style categories) now show selection with a neutral `bg-neutral-100/14 text-fg-0` segment. Accent numerals, "+" and check bullets are now `text-fg-2` or lucide `Check`. The most-popular ring is gone (it's marked by a neutral badge, a stronger hairline and the primary). The platform banner is no longer accent-tinted. The demo gradient and accent spinner are gone. HTTP method chips are neutral. Docs links use `accent-300`. The docs active row is `text-fg-0` with a 2 px accent bar on the rail.
- **Status signals.** Each state now carries a signal hue, a distinct lucide shape (check, alert, x, help) and a word. The brand accent is no longer a status colour, and stock `amber`/`red` are gone.
- **`font-display` restricted** to PageHeader titles, the stat band figures, plan prices and offer prices (large figures). It's gone from the wordmark, footer brand, and every section h2/h3.
- **Tokens only.** `bg-black/40` is now `bg-bg-0/60`. The OG card and canvas background use Shirorekha hexes, each documented against its token, since Satori and CanvasKit can't read CSS variables.
- **Type scale.** Off-scale sizes (11.5, 12.5, 13.5, 14.5, 15, 23, 25, 27 px) moved onto the 12/14/16/18/22/28 steps. Nothing interactive is below 12 px. Long-form legal body copy is now 16 px, capped at 68ch.
- **Hit targets (review pass).** Docs breadcrumb links were 12 px text with a text-sized target; they are now `inline-flex min-h-8`.
- **Hit targets.** Every segment, chip and toggle is at least `h-8`. Header nav links are `h-9`. Mobile menu rows and the toggle are 44 px. Footer, docs sidebar, "On this page" and "Edit this page" links are `min-h-8`. Legal index rows are full-row links.
- **Structure.** The stat band is a `dl`. Value props and plugin activation steps are `ol`s of cards. Features has an "On this page" chip nav, and legal documents have one when they have more than two sections. The status components list sits in a surface card. The grievance details are a two-column `dl` card. The sub-processor table uses `th scope="row"`. Docs link cards use `block` links, so focus rings wrap the card, with a visible border hover. Pricing plans grid is 2 → 3 → 5 columns. The Play/Pause action moved out of the style selection group and gained an icon and an `aria-label`.
- **Empty states.** The styles gallery has "No styles match", one sentence and a "Clear search and filters" action. The changelog has a headline, a sentence and a status link. The status incidents empty state and the docs search no-results message give a next step.
- **Assistive tech.** The gallery count is `aria-live`. The demo's loading text is a visible `role="status"`. "Edit this page" announces that it opens a new tab. The draft banner has a warning icon. Signal icons are `aria-hidden` next to their words.
- Every `data-testid` was kept. No API calls, props contracts, surface gates or business logic changed.

Verification (from `apps/web`): `pnpm exec tsc --noEmit` is clean. `npx vitest run "app/(site)/(marketing)" content --maxWorkers=2` passes 9 files and 80 tests. `pnpm exec eslint <changed files>` reports 0 errors. Prettier has been applied to the changed files. `packages/ui` vitest passes 119 tests.

## Deferred

- **Docs index Plugins card (High, open):** the index still links to `/docs/plugins` while the plugins surface is off, which 404s. The implementer filtered it with `isServerSurfaceEnabled("plugins")`, but the reviewer reverted that hunk: it is a behaviour change, not presentation, and `e2e/docs.spec.ts:14` asserts `docs-section-plugins` is visible. Fix it together with that spec, as a product change.

- **Brand mark** (`components/shell/brand-mark.tsx`, not owned) is still Nocturne's accent-outlined square with a comment to match. DESIGN.md lets the brand mark carry the shirorekha. See sharedRequests.
- **Styles gallery keyboard preview (Medium):** tiles animate only on pointer hover. Making 30 tiles focusable, or adding a per-tile play button, changes the tab order enough to want a design decision and an e2e update (`styles-gallery.spec.ts`).
- **Download page primary:** there is no filled primary now. The natural one is the detected platform's button, but detection is client-side (`usePlatform`). Promoting it needs the card list to become a client component. Left for when the desktop surface ships.
- **Pricing tables on phones:** the burn-rate (640 px) and plan-matrix (720 px) tables scroll horizontally inside their own containers, so the page doesn't scroll sideways. A stacked mobile layout for the matrix would be better.
- **Hero demo placeholder frame:** there's still no sample footage, so captions render over a flat frame. That's a content gap, not a styling one.
- **`MarkdownBody` / `DocsMarkdownBody`** (`lib/content/markdown`, `lib/docs/markdown`, not owned) style the guide and plugin-guide prose. Their headings, links and code blocks weren't audited here.
- **`CodeTabs`** (`app/(site)/developers/code-tabs.tsx`, outside `(marketing)`) renders the API examples. Its tab styling wasn't audited.
- **Dark-only:** recorded in DESIGN.md as a deliberate trade-off against HIG dark-mode.md / color.md › Best practices. Not revisited.
