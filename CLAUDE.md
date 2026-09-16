# CLAUDE.md — Aksharo (repo codename `montaj`)

Read this before touching anything. The most important section is
"Production runs on THIS machine" — getting that wrong takes the live site down.

---

## 1. Production runs on THIS machine

There is no cloud deploy. The public site is served by **processes on this
laptop**, exposed through a **Cloudflare Tunnel**.

`~/.cloudflared/config.yml`:

| Public hostname | Local target |
|---|---|
| `aksharo.crestmondtechnologies.com` | `http://127.0.0.1:3914` (Next web) |
| `aksharo-api.crestmondtechnologies.com` | `http://127.0.0.1:3913` (Nest API) |
| `aksharo-media.crestmondtechnologies.com` | `http://127.0.0.1:9000` (MinIO) |

Backing services are Docker containers that must stay up:
`montaj-postgres` (5432, db `montaj_main`), `montaj-redis` (6379),
`montaj-minio` (9000/9001).

`.env.local-run` is the **production** environment file: `API_PORT=3913`,
`WEB_PORT=3914`, `DATABASE_URL` -> `montaj_main`, and `API_ORIGIN`/`WEB_ORIGIN`
set to the public `crestmondtechnologies.com` hostnames.

### NEVER do these

- **Never kill a process on 3913 or 3914.** They are production.
- **Never run `pkill -f "next dev"`** or any broad process kill. If a dev server
  needs stopping, kill it by the specific PID you started, on the port you chose.
- **Always check who owns a port before killing it:**
  `Get-NetTCPConnection -LocalPort <p> -State Listen` — if you did not start it,
  leave it alone.
- **Never point auth/e2e traffic at `.env.local-run`.** It sends signup and login
  to the **production API** and creates real accounts in `montaj_main`.
  Playwright's `reuseExistingServer` will happily attach to the running
  production API on 3913 — it is not a sandbox.
- Use a scratch port (e.g. 3111) for anything you start yourself, and clean up
  only that port.

### Restoring the stack if it is down (502 = origin not listening)

```bash
# API on 3913 (run from apps/api; it resolves paths relative to its own cwd)
cd apps/api && node --env-file=../../.env.local-run dist/main.js
# if dist/ is missing: pnpm --filter @montaj/api exec nest build

# Web on 3914 (production build; NODE_ENV must be production for `next start`)
# NEXT_DIST_DIR comes from _orchestration/release/web-dist.txt -- do not guess it
cd apps/web && NEXT_DIST_DIR=$(tr -d '\r\n' < "../../../_orchestration/release/web-dist.txt") NODE_ENV=production node --env-file=../../.env.local-run node_modules/next/dist/bin/next start --port 3914
```

**Three worker processes** also run detached, none of them on a port. Two are
long-standing (`worker-media` on probe/proxy, `worker-render`), both started from
`apps/*/dist/index.js`; `worker-ai` runs from `scripts/py.mjs -m worker_ai`. The
third arrived on 2026-09-15 and needs its environment spelled out, because the
defaults are deliberately unsafe to assume:

```bash
# worker-media, pinned to the acquisition queue only
cd apps/worker-media
WORKER_MEDIA_QUEUES=media.acquire \
YT_DLP_PATH='C:\Users\diksh\AppData\Local\Programs\Python\Python312\Scripts\yt-dlp.exe' \
WORKER_MEDIA_YT_DLP_VERIFY=0 \
WORKER_MEDIA_CONCURRENCY=1 \
node --env-file=../../.env.local-run dist/index.js
# log: C:\Users\diksh\AppData\Local\Temp\worker-media-acquire.log
```

Why each of those is there, since removing one looks harmless and is not:

- **`WORKER_MEDIA_QUEUES=media.acquire`** keeps it off probe and proxy, which the
  older worker already serves. Conversely, anything that starts `worker-media`
  with the default queue list now also asks for the acquisition queue — and that
  refuses to boot without a pinned downloader digest. `media-pipeline.e2e-spec.ts`
  names its two queues for exactly this reason.
- **`WORKER_MEDIA_YT_DLP_VERIFY=0`** is the documented opt-out for a
  package-manager build, which is what this machine has: yt-dlp came from pip, so
  `yt-dlp.exe` is a ~108 KB launcher stub and the code lives in site-packages.
  Hashing the stub would be theatre. The **version** pin still applies and matches
  (2026.08.19). The container path keeps the real digest check —
  `apps/worker-media/Dockerfile` downloads the publisher's binary and
  `sha256sum -c`s it — so this opt-out is local, not a weakening of the image.
- **`YT_DLP_PATH`** must be the `.exe`. The digest check reads the file, and the
  bare name `yt-dlp` on PATH is a bash shim Node cannot spawn on Windows.

The **current release runs from `apps/web/.next-live-20260916c`**
(build `6fMUXvjIqwUGBhH1D8xFV`), published 2026-09-16 — the Nocturne front-end
(§5, `docs/NOCTURNE-FRONTEND-2026-09-16.md`).

**The release directory is now recorded in exactly one place:**
`_orchestration/release/web-dist.txt`. `start-production-stack.ps1` reads it
and passes it as `NEXT_DIST_DIR`, and **throws** if it is missing, empty, says
`.next`, or names a directory with no `BUILD_ID`. A deploy must update that
file, or the change is live only until the next reboot. See
`_orchestration/release/README.md`.

> **Check what is live; do not trust this paragraph.** On 2026-09-16 it claimed
> `.next-live-20260915c` was serving and it was wrong — the process had been
> started with **no `NEXT_DIST_DIR` at all**, so it was serving the default
> `.next`. A routine `pnpm --filter @montaj/web build` then overwrote `.next`
> underneath the running process: `next start` holds its manifests in memory,
> so the live HTML kept asking for chunk and CSS filenames that no longer
> existed on disk, and **the public site served its stylesheet as a 400 for
> about two hours, unstyled.**
>
> It then happened a second time the same day for the other reason: the 19:23
> reboot ran `start-production-stack.ps1`, which also set no `NEXT_DIST_DIR`,
> so the stack came back on `.next` rather than on the release deployed at
> 11:26. That script now reads `_orchestration/release/web-dist.txt` and
> throws rather than falling back — but the two rules still apply, because a
> hand restart can still get it wrong.
>
> 1. **Always build into a NEW directory** — `NEXT_DIST_DIR=.next-live-<date>`
>    — never into `.next`, even for a throwaway check. `.next` may be what
>    production is serving.
> 2. **Verify which build is actually live before you touch anything**, because
>    a running process cannot be asked for its `NEXT_DIST_DIR`. Compare a
>    served asset against the candidate directories:
>
> ```bash
> # the CSS the live server is serving right now
> curl -s http://127.0.0.1:3914/ | grep -o '/_next/static/css/[a-f0-9]*\.css' | sort -u
> # which dist dir contains it (and therefore which one booted)
> cd apps/web && for d in .next*/; do \
>   [ -f "$d/static/css/<hash>.css" ] && echo "$d ($(cat $d/BUILD_ID))"; done
> ```
>
> If that asset 400s or 404s, the process is already orphaned from its build
> directory and the site is degraded — restart it onto a complete build.

The repurposing surface is **no longer inert**. `repurpose_flow` and
`source_youtube_acquire` are both enabled, targeted at workspace
`01M1KFX35NJRD5N58H0J6YGAPC` only, and a YouTube link now runs the whole way
through acquire -> probe -> proxy -> transcribe. It stops at "Finding promising
moments", because highlight discovery has no producer yet. Direct media URLs are
still refused **in code**, flag or no flag: `parseSourceUrl` accepts any https
host ending in a media extension and resolves nothing, so accepting one would
point a downloader running on this machine at any address that ends in `.mp4` —
including addresses only this machine can reach. That needs an egress policy
before it is switched on.

Retained for rollback, newest first: `.next-live-20260916b` (build
`CQ3rQW6qp4-AwmacgVdBt`, Nocturne before the contrast fixes — its outlined
primary button drops to 3.4:1 when pressed — and before the workspace
switcher moved into the profile menu, so on that build a user with two
workspaces cannot switch), `.next-live-20260916a` (build
`Gb_mWFi6_ZKNyVQ4Iv5kT`, as 16b plus four stale lime/zinc literals in the
marketing hero tile, the OG card, the `themeColor` and the Razorpay widget),
`.next-live-20260915c` (build
`BW5EXx1_ZNWmleSPfNRYL`, the last pre-Nocturne build — note it was built but,
as above, never actually served), `.next-live-20260915b` (build
`xJsfGwIkxLyIIJWuKbQ9V`, the same code with links refused),
`.next-repurpose-live-20260915` (build `-XBuUUyZGlEQjidK9pSc7`, no home entry
point and no upload wiring), `.next-typography-live-20260913` (build
`FVSuJD4Q1Btz16IpOz78T`, the 3 "editorial" kinetic-typography templates),
`.next-caption-live-20260912` (build `fzstBbkQAwLxfxTeVNKtz`), then `.next`.
Rolling back is a restart with `NEXT_DIST_DIR` pointed at one of them — the
2026-09-15 database migration is additive and older code ignores its tables.
Deployment details are in `scratch/typography-live-deployment.json` for the
2026-09-13 release, and in the master plan's `DEPLOY-0001` record for this one.
A future build should use a new output directory while the live process is
running, then switch the web service to it.

`.env.local-run` contains multi-line quoted PEM keys (`JWT_PRIVATE_KEY`).
Shell `source` breaks on them — use Node's `--env-file` / `process.loadEnvFile()`.

Health checks:
```bash
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3913/health   # 200
curl -o /dev/null -w "%{http_code}\n" https://aksharo.crestmondtechnologies.com/   # 200
```

---

## 2. "Deploying" means rebuild + restart locally

There is **no git remote** on this checkout and no reachable CI. `git push` is
not a deploy and cannot work. `docs/runbooks/deploy.md` describes an AWS EKS/ECR
setup that does **not** exist on this machine (`aws`, `helm`, `terraform` are not
installed; `kubectl` has no context). Ignore it.

To ship a change:

```bash
pnpm --filter @montaj/web build      # or the package you changed
# restart the 3914 process (section 1)
```

A schema change also needs the migration applied to the production database
BEFORE the API restarts. `.env.local-run` carries the production `DATABASE_URL`
and multi-line PEM keys, so pass it through Node rather than `source`:

```bash
# reads DATABASE_URL out of .env.local-run and runs prisma migrate deploy + prisma/sql
node -e "const m=/^DATABASE_URL=\"?([^\"\n]+)/m.exec(require('fs').readFileSync('.env.local-run','utf8'));process.env.DATABASE_URL=m[1];require('child_process').spawnSync('pnpm',['--filter','@montaj/api','db:migrate'],{stdio:'inherit',shell:true,env:process.env})"
```

The two live processes are **detached** — their launching shell has exited — so a
restart must detach too, or the service dies with the terminal that started it.
On Windows that means `Start-Process -WindowStyle Hidden` with an explicit
`-WorkingDirectory`; `next start` resolves the project from the working
directory, so running it from the repository root silently looks for `.next`
there and fails with "Could not find a production build".

Committing alone changes nothing that a user can see.

---

## 3. Verify a change is actually live — do not assume

```bash
# 1. the built bundle contains it
grep -rl "<a class or string you added>" apps/web/.next-caption-live-20260912/static/css/

# 2. the public asset contains it (through Cloudflare)
curl -s https://aksharo.crestmondtechnologies.com/_next/static/css/<hash>.css | grep "<string>"

# 3. computed styles in a real browser (Playwright is installed; do not install one)
```

HTML is served `no-store`/`DYNAMIC`, and CSS/JS filenames are content-hashed, so
Cloudflare caching is **not** a reason a change fails to appear. If a change is
missing, the build or the restart was skipped.

---

## 4. Quality gates

```bash
pnpm --filter @montaj/web typecheck        # must be clean
pnpm --filter @montaj/web lint             # baseline is 20 PRE-EXISTING errors
                                           # (CaptionStage.tsx, qa-sweep/*, plus
                                           # import/order in the editor + nav files
                                           # the Sep-2026 parity work touched) — do
                                           # not "fix" them, just do not add more.
                                           # Was 13; re-count with
                                           # `pnpm --filter @montaj/web lint 2>&1 | tail -2`
                                           # rather than trusting this number.
npx vitest run components/editor --maxWorkers=2
pnpm --filter @montaj/caption-styles test
pnpm --filter @montaj/render-core test
pnpm --filter @montaj/web build            # must exit 0
```

The e2e suite runs against the **production API** (see §1) — do not point it
there. Its account fixtures have been unreliable; verify the fixture before
trusting a red e2e run as a product failure.

What `POST /auth/signup` actually does here (measured 2026-09-10, correcting an
earlier note in this file that claimed it auto-logs-in): it answers **202
`{"status":"verification_sent"}`**. Because `.env.local-run` sets
`AUTH_DEV_AUTO_VERIFY=1` the account is usable straight away, so
`POST /auth/login` with the same credentials succeeds immediately — there is no
inbox step to wait for.

---

## 4b. The upload path (measured end to end, 2026-09-10)

The whole chain is healthy; if a user says "I can't upload", find out **where**
before assuming a service is down.

```
browser: hash file (streaming SHA-256 in a Web Worker chunk)
  -> POST /projects                    (creates the project; sourceLanguage set here)
  -> POST /projects/{id}/media/init    (413 if over the plan's maxFileBytes)
  -> PUT   each 16 MiB part -> aksharo-media...  (presigned; ETag read per part)
  -> POST /projects/{id}/media/{mediaId}/complete
  -> POST /projects/{id}/transcribe    (409 media/not_ready is EXPECTED, see below)
```

Facts worth not re-deriving:

- **MinIO exposes `ETag`** on the actual PUT response (`Access-Control-Expose-Headers`),
  which is what `part-upload.ts` needs. A preflight not listing it means nothing —
  expose-headers only matters on the real response.
- **Part size is 16 MiB**, well under Cloudflare's request-body limit. Not a suspect.
- **`connect-src` is `'self' https:`**, so the media host is allowed. Not a suspect.
- The **409 on `/transcribe` right after `complete` is by design**: the probe has
  not run yet. `AutoTranscribeTrigger` (`apps/api/src/transcripts/`) restarts it
  on `media.proxy` success — but only when the project has a `sourceLanguage`,
  no existing transcript or edg document, and the workspace has credits.
- **CORRECTED 2026-09-14.** This file used to say a brand-new Free workspace is
  created with 0 credits and 0 monthly grant, so a fresh account's upload
  succeeded and transcription silently never started. That was true and it was a
  bug, not a behaviour: sign-up created the user, the workspace, the membership
  and the consent rows and stopped, so no subscription, credit account or grant
  ever existed (launch-readiness P0-07). `users.service.ts` now calls
  `provisionFreeEntitlement` inside the sign-up transaction, and a fresh account
  starts with the Free plan's 20 credits. **A new account with zero credits is
  now a symptom to investigate, not the expected state** — most likely an
  unseeded database, which that function refuses loudly rather than papering
  over.
- **The Free plan cap is 500 MB / 20 min.** The size cap is enforced at `init`;
  the duration cap only after probing.

Diagnosing without guessing: `access_logs` (per workspace) shows whether the
browser reached the API at all. No `project.create` row means the failure was
**client-side, before any request** — look at the file picker, the Prepare Media
modal and hashing, not at the server.

---

## 4c. Changed on 2026-09-14 (launch-readiness pass)

Things this file, the runbooks or your muscle memory may still have wrong. Full
record in `docs/LAUNCH-READINESS-IMPLEMENTATION-2026-09-14.md`.

- **The brand is Aksharo.** Commit `0be69d36` overwrote
  `packages/config/src/brand.ts` with a competitor's name, domain, deep-link
  scheme and support address (`Kalakar` / `kalakar.io`), and the built `dist/`
  carried it into every app. Restored, with `FORBIDDEN_BRAND_NAMES` and a test so
  it cannot come back quietly. Kalakar is the product being *visually* studied;
  it is not this product's name.
- **`TRUST_PROXY` is a hop count, not a boolean.** It used to read the left-most
  `X-Forwarded-For` value, which the client supplies. It now counts trusted hops
  from the **right**. `TRUST_PROXY=1` still behaves correctly for a single proxy;
  behind Cloudflare *and* an ingress it must be `2`.
- **Password minimum is 15** (was 10), and the compromised-password check now
  defaults **on**. A local blocklist applies regardless of network reachability.
- **Sign-out revokes server-side.** `POST /api/session/logout` is the route;
  `clearSession()` only drops the cookie and is correct solely when the family is
  already dead.
- **Swagger is off under `NODE_ENV=production`** unless `API_DOCS_ENABLED=1`.
- **`realtime` and `scheduler` are not deployed.** They were never separate
  processes — the API image ignored `--role`, and now refuses to start with an
  unimplemented one. The API serves `/realtime` itself.
- **Migrations run `db:migrate`, not `prisma migrate deploy`.** Only the former
  applies the hand-written DDL in `prisma/sql/`. Production seeds reference data
  only (`db:seed:reference`); the demo workspace seed refuses under
  `NODE_ENV=production`.
- **Do not import a `.json` file from a package that ships an ESM build.**
  `resolveJsonModule` emits an import real ESM rejects without
  `with { type: "json" }`, and TypeScript will not accept that attribute while
  also emitting CommonJS. This silently killed every render worker thread. Put
  the data in a `.ts` module.

## 5. Design system — **Nocturne** (changed 2026-09-16)

The look is **Nocturne**, from the premium design canvas in
`New folder/Premium software frontend design/`: `Aksharo Studio (premium).dc.html`
is the screen-by-screen source and `_ds/nocturne-*/readme.md` is the written
system. If a screen and this file disagree, the canvas wins.

**This replaced a zinc-and-lime palette (and, before a partial pass, a
zinc-and-mint one). There is no lime and no mint in this product any more.**
The `lime-*`/`mint*` CSS variables still exist because 80-odd files consume
them; they resolve to the accent. Do not reintroduce `#d8ff3d` or `#49a781`,
and do not "fix" a `lime-500` class name — renaming them is a separate,
mechanical diff.

Tokens live in `packages/ui/src/styles/tokens.css` (Tailwind v4 `@theme`) with a
data copy in `packages/ui/src/tokens.ts`; `tokens.test.ts` pins the two together
and fails on a pure black or pure white anywhere outside the caption defaults.
They are the ONLY legal source of colour/size — never a raw hex, never
`white/NN`:

`bg-bg-0 #161826` (page) · `bg-surface #232532` (cards) · `bg-sunken #101220` (rails,
timelines) · `bg-ink #0a0b12` (the video canvas, the one near-black)
`text-fg-0 #e9e9ed` · `text-fg-1 #cfd3e5` · `text-fg-2 #9397ab` · `text-fg-disabled #75798c`
accent `#9184d9` — `text-accent` / `border-accent`, hover one step *lighter*
(`accent-400`), plus the 100–900 ramps `accent-*` and `neutral-*`
signals `proposed / accepted / rejected / info / warning` (their own hues, on purpose)
radii `rounded-sm` 8 · `rounded-md` 12 · `rounded-lg` 14 · type `text-2xs` 11 / `text-xs` 12 / `text-sm` 14

Caption colours are a **different palette** from chrome: fill `#ffffff`,
highlight `#ffd400`, stroke `#000000`. Never use the brand accent as a caption
colour — these burn into exported video over footage nobody controls.

**Accent discipline.** Nocturne spends the accent on *lines, glows and tints*,
never as a flood: "do not flood large areas with the accent". So

- **the primary button is an accent outline on transparent, not a fill**
  (`Button variant="primary"`; `primitives.test.tsx` asserts the absence of a
  fill). `danger` keeps its fill — destruction has to be unmistakable.
- the accent is otherwise for: an active nav row (`bg-accent/12-16` +
  `text-accent-200`), an active tab's underline, a switch that is ON, a filled
  meter track, a selected card's ring (`shadow-[0_0_0_1px_var(--color-accent)]`),
  a kicker over a card, and at most one primary action per surface.
- the ONE exception to "no saturated fields" is the marketing page's stat band,
  which uses `bg-section`. Nothing else may.

**Rules fade at their ends.** A freestanding rule uses the `rule-fade` utility,
and a rule along an element's bottom edge uses `rule-fade-b`, not `border-b` —
both paint the divider fading to transparent 48 px from each end. Box outlines,
in-control separators and short accent marks stay solid.

**Headings are weight 500.** Size and space carry the hierarchy; `tokens.css`
sets this on bare `h1`–`h6`. Inter for both headings and body.

**A link inside an `<li>` that is navigation, not prose, needs `no-underline`.**
The base stylesheet underlines any `<a>` inside a text block for WCAG 1.4.1;
that is right for a link in a sentence and wrong for a section list or a row of
stage pills.

**Shell.** Two widths, switched from the header and remembered per browser
(`components/shell/nav-model.ts`): a 68 px `NavRail` (the default) and the
232 px `Sidebar`. `PRIMARY_NAV` is the canvas's eight destinations; the routes
it had no room for live in `SECONDARY_NAV`, which the sidebar shows under
"More" and the command palette offers in full. A disabled nav row is never
"active", whatever the path says.

The editor panel's row recipes live in
`apps/web/components/editor/panels/controls.tsx` — copy them rather than
inventing new ones. The three native controls (`.panel-range`, `.panel-swatch`,
`.panel-switch`) are in `apps/web/app/globals.css` because they need
pseudo-elements; they must stay native elements because tests drive them with
`toHaveValue()` and `fill()`.

**Never remove a `data-testid`.** Unit tests and Playwright specs assert on them.

**Seeing the screens.** `apps/web/e2e/nocturne-shots.spec.ts` captures every
rebuilt screen at the canvas's own 1440 × 900 into `test-results-nocturne/`. It
is a verification aid, not a gate, and it must run against a scratch stack —
its header comment has the exact command, and §1's warning about
`.env.local-run` applies: it signs up an account.

---

## 6. Known traps

- **`@montaj/caption-styles` in client code:** import runtime values from
  `@montaj/caption-styles/browser`, never the barrel. The barrel re-exports the
  fs-backed `registry.ts` (`node:fs`, `__dirname`), and its CommonJS build breaks
  `next dev` outright (React Refresh appends `import.meta` to a CJS module,
  because pnpm resolves the package outside `node_modules` so Next's exclusion
  misses it). `transpilePackages` does **not** fix this. Type-only imports are
  erased and may use the barrel. Same pattern already used by `@montaj/fonts`.
- **CSP deliberately withholds `'unsafe-eval'`** (asserted by
  `next.config.test.ts`). Under `next dev` this blanks the CanvasKit style
  previews. Do not weaken the CSP; use a production build to view them.
- Windows: Git Bash mangles `/path` arguments (`MSYS_NO_PATHCONV=1`) and octal-ish
  backslash escapes in heredocs. Prefer forward slashes.

---

## 7. Scope discipline

State plainly which surfaces a change covers. A design mockup covering the whole
editor is not the same as implementing it: restyling the right panel does not
change the top bar, transcript column, canvas or timeline, and the user WILL
compare against the mockup. Say what was and was not built.
