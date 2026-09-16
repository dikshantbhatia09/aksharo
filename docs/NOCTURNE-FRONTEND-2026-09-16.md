# Nocturne front-end implementation — 2026-09-16

The premium design canvas in
`New folder/Premium software frontend design/` — `Aksharo Studio (premium).dc.html`
plus its design system, `_ds/nocturne-b1009d34-.../` — implemented in the web app.

The canvas is a single prototype with nine screens behind an `sc-if` switch:
studio, editor, projects, styles, repurpose, billing, settings, onboarding and
the signed-out site. This record says what was built, what was deliberately
not, and where the canvas and the product could not agree.

---

## 1. The theme

`packages/ui/src/styles/tokens.css` was rewritten to Nocturne, and
`packages/ui/src/tokens.ts` with it. The existing token *names* were kept and
repointed, which is what moved ~80 files' worth of chrome in one edit:

| Role | Was (zinc/mint) | Now (Nocturne) |
| --- | --- | --- |
| page | `#0d0d0d` | `#161826` |
| surface | `#18181b` | `#232532` |
| sunken / rails | — | `#101220` |
| video canvas | — | `#0a0b12` |
| accent | `#49a781` mint (before that `#d8ff3d` lime) | `#9184d9` blurple |
| text | zinc ramp | blue-tinted neutral ramp |
| display face | Bricolage Grotesque | Inter (Nocturne pairs Inter with Inter) |

Added: `--color-surface/-sunken/-ink/-divider/-section`, the 100–900
`--color-accent-*` and `--color-neutral-*` ramps, `--shadow-sm/md/lg`, and the
`rule-fade` / `rule-fade-b` utilities for Nocturne's rules that fade out 48 px
from each end.

`tokens.test.ts` now pins every ramp step and **fails on a pure black or pure
white anywhere outside the caption defaults**, which is Nocturne's one hard
colour rule.

### The primary button is no longer filled

Nocturne outlines it: "Buttons are outlined (1px accent border on
transparent), not solid-filled", and "do not flood large areas with the
accent". `Button variant="primary"` is now an accent outline; `danger` keeps
its fill, because destruction has to be unmistakable rather than read as one
more option. `primitives.test.tsx` asserts the *absence* of a fill, so a
future "make the primary pop" change has to come past a test.

### Off-palette values swept out

Hard-coded `#10B981`, `#FFB800`, `#181D21`, `#252D33`, `bg-white`, `bg-black`
and `white/NN` were removed from `AudioPanel`, `CaptionStage`,
`prepare-media-modal`, `project-card`, `project-kebab-menu`, the export panels
and `(app)/error.tsx`. Two literals remain by design and are named as such:
`Timeline.tsx`'s two `ctx.fillStyle` constants (a 2D canvas cannot take a CSS
variable) and `StylePreviewCanvas`'s CanvasKit clear colour.

---

## 2. The shell

Two widths, as the canvas ships them, switched from the header and remembered
per browser (`components/shell/nav-model.ts`):

- **`NavRail`** (new, the default): 68 px, the अ brand mark, eight destinations
  as icon-over-caption, the credit balance as a bolt and a number, the avatar.
- **`Sidebar`** (rebuilt): 232 px, the brand lockup with the workspace name
  under it, the same eight, then a "More" group, then the credit card, the
  storage line and the profile row.

`TopBar` became the canvas's 52 px header: a 9.5 px uppercase breadcrumb over a
15 px title (`screen-title.ts`), then the Rail/Sidebar switch, search, New
project, What's new and Upgrade.

**Navigation changed shape.** The canvas's rail carries eight destinations and
they are not the eight `PRIMARY_NAV` used to list. Templates, Academy, Plugins,
Team, Refer & Earn and Help moved to a new `SECONDARY_NAV` — the sidebar shows
them under "More" and the command palette (now `ALL_NAV`) offers every one.
Nothing became unreachable; `lib/nav.test.ts` asserts that.

The rail's **Editor** entry has no route of its own — this app's editor is
`/p/[id]`. It resolves to the workspace's most recently updated project and
goes disabled with "The editor opens a project. Upload something first." when
there is none. Sending a new user to `/projects` under the label "Editor"
would be a lie about where the click goes.

Removed: the gold "✦ Aura" button (a second accent, not in the canvas, no test
referenced it) and the stacked Audio-Clean meter (it restated the *same*
credit balance the card already shows — `credits.ts` charges `audioClean` the
identical rate as `transcribe`).

---

## 3. The screens

| Canvas screen | Where | Notes |
| --- | --- | --- |
| Studio | `(app)/home/home-view.tsx` | Four bands: `PipelineBanner`, the New-project card (pitch + quick picks + drop well), `WorkingNowCard` / `ThisMonthCard`, the project grid. Upload, batch and Prepare-Media machinery untouched. |
| Projects | `(app)/projects` | Rebuilt as the canvas's **table** (`project-table.tsx`): thumbnail, project, status, language, length, credits, updated. A Table/Grid toggle keeps the card grid. |
| Styles | `(app)/studio/styles` | New catalogue: category shelf, Roman/Devanagari/Tamil preview-script switch, 66 tiles drawn by the real renderer. |
| Clips pipeline | `(app)/repurpose` (new index) and `[runId]` | Canvas layout: pitch, source row, numbered stage rail, stage card with the CTA row inside it, and the Source aside. |
| Plan and credits | `components/billing/overview-panel.tsx` | Canvas's three-card band (plan / credits / what N credits buys), then the plans table and the ledger on the same screen. |
| Settings | `(app)/settings/layout.tsx` | 196 px section column, accent-tinted selection, 720 px content. |
| First run | `(app)/onboarding` | Four step dots instead of a progress bar; icon rows for step 1, chips for languages and source; "Open the studio" / "Try a sample project" to finish. |
| Signed-out site | `(site)/(marketing)` | Segmented locale switch, left-aligned hero, the stat band in `--color-section`, value props, CTA as a surface card. |
| Editor | `(app)/p/[id]` | **Re-themed, not re-laid-out** — see §4. |

---

## 4. Where the canvas and the product could not agree

Each of these is a place the canvas draws something the product cannot
truthfully render. In every case the canvas's *visual language* was kept and
the *data* was left honest.

1. **The pipeline has five stages, not ten.** The canvas draws Upload,
   Analyse, Select clips, Reframe, Captions, Versions, Review, Schedule,
   Publish, Measure. `RepurposeStageView` has `getting_video`,
   `finding_clips`, `styles_formats`, `review`, `publish` — a server contract.
   Drawing ten would mean five pills no run can ever be "at", two of which
   (Schedule, Measure) have no endpoint at all. The rail is the canvas's rail
   over the five that exist, and the live line says "stage 2 of 5".

2. **No per-project credit total exists.** The canvas's Credits column is
   summed from each row's own jobs (`useProjectJobs`), one request per visible
   row — the same cost the card grid always paid, and the alternative (one
   paginated workspace-wide `GET /jobs`) would silently under-count an older
   project.

3. **`ProjectPage` has no `total`.** The sidebar's Projects count is shown
   only when the first page *is* the whole list; past that the badge is
   omitted rather than reporting "the first eight" as a total.

4. **"41 more Reels at the length you usually post"** needs a per-workspace
   median clip length that nothing computes. The studio's credit card states
   the hours only. The billing card's "What N credits buys" keeps all three
   rows but puts the assumption in each label — "Reels at 40 seconds",
   "Podcast episodes at 45 minutes".

5. **The editor was re-themed, not rebuilt.** `(app)/p/[id]` is a 1476-line
   resizable four-zone layout built from an *earlier* reference design
   (`Caption Editor.dc.html`), and its geometry — transcript | preview |
   inspector over a timeline — is already the canvas's geometry. It moved to
   the Nocturne palette through the tokens, its selected caption row now takes
   the accent tint plus a 2 px accent bar, its inspector tabs sit on a fading
   rule, and its off-palette literals are gone. Its panels were **not**
   re-laid-out to the canvas's simplified three-column mock; that is a
   separate piece of work against the surface with the most tests.

6. **Icons are Lucide, not Phosphor.** The canvas and the Nocturne readme
   specify Phosphor. Both are 1.5 px outline sets and the named equivalents
   are near-identical at 14–19 px, but the rest of this app — the editor,
   every admin screen, a hundred-odd files — is already Lucide, and shipping a
   second icon library for eight rail entries would put two icon languages on
   the same screen. `lib/nav.ts` names the Phosphor icon the canvas asked for
   beside each substitution, so the swap is auditable. Lucide has no brand
   marks (it dropped them), so "Long YouTube" uses `MonitorPlay`.

7. **Copy was kept where the repo's was richer.** The marketing page's value
   props and social proof come from `content/site/*` and were not overwritten
   with the canvas's placeholder sentences; the layout and palette are the
   canvas's.

---

## 5. Gates

- `pnpm --filter @montaj/web typecheck` — clean.
- `pnpm --filter @montaj/web lint` — 10 errors, all pre-existing
  (`qa-sweep/*`, `export-harness`). The baseline in CLAUDE.md §4 was 20;
  `eslint --fix` resolved ten import-order errors along the way.
- `npx vitest run` (web) — 1372 passing.
- `@montaj/ui`, `@montaj/caption-styles`, `@montaj/render-core` — passing.
- `pnpm --filter @montaj/web build` — exits 0.
- `apps/web/e2e/nocturne-shots.spec.ts` — nine screens captured at 1440 × 900
  against a scratch stack (isolated `montaj-e2e-*` containers, API on 3131,
  web on 3132). Never run it against `.env.local-run`.

Nothing in this change was deployed: the live processes on 3913/3914 are
untouched, and §2 of CLAUDE.md is still the way to ship it.

---

## 6. Deployment — 2026-09-16

Shipped the way CLAUDE.md §2 describes: rebuild, then restart the detached
`next start` on 3914. The API on 3913 and the three workers were **not**
restarted and did not need to be — `apps/api` imports none of the packages
this change touched (`@montaj/ui`, `@montaj/api-client`), and the change
carries no database migration.

Final build: **`.next-live-20260916b`**, build id `CQ3rQW6qp4-AwmacgVdBt`.

Procedure used, and worth reusing:

1. Build into a **new** directory with the production env, so the live process
   keeps serving its own build untouched:
   ```
   cd apps/web
   NEXT_DIST_DIR=.next-live-20260916b NODE_ENV=production \
     node --env-file=../../.env.local-run node_modules/next/dist/bin/next build
   ```
   `NODE_ENV=production` and `API_ORIGIN` must be present **at build time** —
   `next.config.ts` bakes them into the CSP. Verified in the output before
   switching: `connect-src` carries `https://aksharo-api.crestmondtechnologies.com`.
2. **Pre-flight the new build on a scratch port (3915)** and confirm it boots,
   serves its stylesheet and answers on every public route. A boot failure
   found here costs nothing; found after the swap it is an outage.
3. Swap: stop the 3914 process, `Start-Process -WindowStyle Hidden` with an
   explicit `-WorkingDirectory` (the service must survive the launching shell),
   `NEXT_DIST_DIR` and `NODE_ENV=production` set in the parent shell so the
   child inherits them.
4. Verify through Cloudflare, not just locally: page 200, **stylesheet 200 and
   containing the new token values**, every public route 200, API still 200,
   then a real browser.

Rollback is the same restart with `NEXT_DIST_DIR=.next-live-20260916a` (the
same release, four stale colour literals) or `.next-live-20260915c` (the last
pre-Nocturne build). Both are intact.

### The incident this deploy also fixed

The live site had been **serving unstyled for roughly two hours** before this
deploy, and this work caused it.

The 3914 process (started 09:22) had been launched with **no `NEXT_DIST_DIR`**,
so it was serving the default `.next` — not `.next-live-20260915c`, which
CLAUDE.md §1 claimed was live. At 11:00 a routine verification build
(`pnpm --filter @montaj/web build`, which defaults to `.next`) overwrote that
directory underneath the running process. `next start` holds its manifests in
memory, so it kept emitting HTML referencing content-hashed filenames that no
longer existed on disk: the page returned 200, the stylesheet returned 400, and
every health check passed while the site rendered with no CSS.

Two changes came out of it, both in CLAUDE.md §1: never build into `.next` on
this machine, and a command for determining which build a running process is
actually serving (you cannot ask it). The paragraph that was wrong now says so.


---

## 7. Second deploy, same day — the audit's findings, and the boot fix

`.next-live-20260916b` (§6) shipped before the pre-deploy audit finished. The
audit cleared the API and the workers, independently reconstructed the `.next`
incident, and verified the shipped build was complete (840 class tokens from
the 63 changed files, all present). It also found four things that were real.
All four are fixed and shipped as **`.next-live-20260916c`**, build
`6fMUXvjIqwUGBhH1D8xFV`.

### Contrast regressions the palette swap caused

Measured, not estimated (the ratios below are computed from the tokens and
were re-checked against the deployed stylesheet in a real browser):

| | before | after |
| --- | --- | --- |
| primary button label, hovered on a card | **3.97:1** | 8.54:1 |
| primary button label, pressed on a card | **3.37:1** | 8.83:1 |
| `Badge tone="accent"` (11 px) | **4.06:1** | 8.72:1 |
| `text-neutral-600` as body text | **3.52–4.08:1** | 5.25–6.08:1 |

The button one is the interesting failure. With a *filled* button the hover
tint sits behind the label and contrast rises; with an **outline** the label
*is* the accent, so tinting the ground alone pushes it the wrong way. The fix
moves the label one step up the ramp on hover and another on active — which is
also what Nocturne asks for on a dark ground. `neutral-600` turned out to be a
border/dot colour being used as text; those moved to `neutral-500`.

### A functional regression, not a styling one

With the 68 px rail as the default shell, **a user with two workspaces had no
way to switch workspace.** The switcher only ever lived in the sidebar, and the
sidebar's only other mount is a sheet whose trigger is `lg:hidden`. It now
lives in the profile menu, which both shells carry, and
`shell.test.tsx` covers it.

The streak chip (`growth.streakWidget` is ON in production) had fallen off the
same way and is back in the rail's footer.

### The rail's Clips entry was not flag-aware

`repurpose_flow` is targeted at one workspace, and the canvas puts Clips
**first** in the rail. Every other workspace saw it as the topmost button and
landed on a "not on for you" screen — and it was the only always-visible trace
of the surface, since `PipelineBanner` renders nothing when the flag is off.
`useNavItems` now gates it the same way it gates Editor.

### e2e contracts the redesign moved

`/projects` opens on the table, so `project-card` is behind the Table/Grid
toggle; `credit-meter` no longer exists. Four specs outside the diff
(`projects`, `upload`, `gate-a`, `auth`) were re-pointed — a `showProjectGrid`
helper makes the precondition explicit and leaves every assertion verbatim.

---

## 8. The boot path — the real fix for the `.next` problem

The `.next` incident happened **twice** on 2026-09-16: once from a build at
11:00, and again at the 19:23 reboot, which brought the stack back on `.next`
instead of the release deployed at 11:26. (The same reboot left the Cloudflare
tunnel down, so the public site answered 530 until its scheduled task was
restarted — unrelated to the deploy, but it is why both hostnames were down.)

Both had one cause: `_orchestration/tools/start-production-stack.ps1` launched
`next start` with **no `NEXT_DIST_DIR`**, so the default `.next` was always the
live directory — and `.next` is exactly what a routine build overwrites.

That script now reads **`_orchestration/release/web-dist.txt`**, one file
holding one line, and:

- passes it as `NEXT_DIST_DIR`, with `NODE_ENV=production`, set on the parent
  shell so the `Start-Process` child inherits them (PowerShell 5.1 has no
  `-Environment`), then clears both;
- **throws** if the file is missing, empty, says `.next`, or names a directory
  with no `BUILD_ID`. A loud boot failure is far cheaper than a silently wrong
  one;
- prints the directory and build id it resolved, so the boot log says what it
  started.

**A deploy must now update that file.** `_orchestration/release/README.md` has
the four-step procedure. Skip step 3 and the deploy is live only until the next
reboot.

### Verifying which build is live — positively

Grepping the public CSS for a token value is not proof: two dist directories
can emit byte-identical assets and differ only in `BUILD_ID`. The probe that
actually proves it:

```bash
# must be 200 for the directory you intended...
curl -o /dev/null -w "%{http_code}
"   http://127.0.0.1:3914/_next/static/<BUILD_ID of intended dir>/_ssgManifest.js
# ...and 404 for .next
curl -o /dev/null -w "%{http_code}
"   http://127.0.0.1:3914/_next/static/<BUILD_ID of .next>/_ssgManifest.js
```

Run for this release: `6fMUXvjIqwUGBhH1D8xFV` → 200,
`klnf3PuLU6EqzZZ2r8gG5` (`.next`) → 404, through Cloudflare.
