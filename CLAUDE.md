# CLAUDE.md — Aksharo (repo codename `montaj`)

Read this before touching anything. The most important section is
"Production runs on THIS machine" — getting that wrong takes the live site down.

---

## 1. Production runs on THIS machine

> **Changed 2026-09-19 — production no longer runs from this folder.** It runs
> from `05-build/montaj-release`, a git worktree **detached at a verified commit
> of `main`** (which build is live: `_orchestration/release/web-dist.txt`; what each release
> shipped and how to undo it: the newest `_orchestration/tools/deploy-*.ps1` and
> its `rollback-*`. Several deploys a day are normal now, so this file no
> longer names one; §13). Until then it ran whatever uncommitted files sat in
> `montaj`, which coding agents edit. Rules:
>
> - **Never build into or restart from `montaj`.** Verify a change in the clean
>   worktree `05-build/montaj-verify`, commit there, move `main`, push.
> - **Deploy** = `git -C ../montaj-release checkout --detach <sha>`, rebuild
>   there (`pnpm -r --no-bail --filter "./packages/**" build` — `@montaj/db`
>   always fails and nothing in production uses it — then api, worker-media,
>   render, and web with `NEXT_DIST_DIR=.next-live-<date>`), then run a deploy
>   script modelled on `_orchestration/tools/deploy-20260919c.ps1` (it stops
>   production by process tree, repoints `start-production-stack.ps1` and
>   `web-dist.txt`, starts, and health-checks). Rollback:
>   `rollback-20260919c.ps1`. `next build` rewrites `apps/web/next-env.d.ts` and
>   `tsconfig.json` in the release copy; that is expected, do not commit it.
> - `montaj-release/.env.local-run` is a **hard link** to `montaj/.env.local-run`
>   (one file, one set of secrets). Edit it in place (`WriteAllText` /
>   `r+`), never by writing a new file and renaming, or the link splits.
>   `montaj-release/apps/worker-ai/.venv` is a junction to montaj's venv.
> - Production feature flags (owner decision 2026-09-19): public shares and
>   affiliates ON, checkout and every other launch surface OFF.
>   `RAZORPAY_WEBHOOK_SECRET` is now a random value — with it empty, the fake
>   billing provider accepted webhooks signed with its public default secret.
> - Production still runs `NODE_ENV=development`, `MAIL_PROVIDER=dev` (no email
>   is sent) and `MONTAJ_SCHEDULER_DISABLED=1` (no scheduled task runs: no status
>   snapshots, retention, stuck-run sweep). Switching NODE_ENV to production
>   needs a real mail provider and a SENTRY_DSN or its opt-out flag first.
> - The paragraphs below that name `montaj` paths, `.next-live-20260917c`, or
>   "no git remote" describe the setup before this change.

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

**Four worker processes** now run detached, none of them on a port:
`render` and `worker-ai` (started from `apps/render/dist/index.js` and
`scripts/py.mjs -m worker_ai`), and **two** `worker-media` processes that split
the three media queues between them — this split is now baked into
`start-production-stack.ps1` itself, not a command you run by hand:

```powershell
# the plain one: probe, proxy and clip -- never touches the yt-dlp digest check
WORKER_MEDIA_QUEUES=media.probe,media.proxy,media.clip   node dist/index.js   # apps/worker-media

# the acquisition one: pinned to the acquisition queue, digest check disabled
# for this machine's build (yt-dlp came from pip, so it is a launcher stub --
# hashing it would be theatre)
WORKER_MEDIA_QUEUES=media.acquire
YT_DLP_PATH=C:\Users\diksh\AppData\Local\Programs\Python\Python312\Scripts\yt-dlp.exe
WORKER_MEDIA_YT_DLP_VERIFY=0
WORKER_MEDIA_CONCURRENCY=1                    node dist/index.js   # apps/worker-media
```

**Found broken 2026-09-16, fixed the same day (§8).** Before this, the boot
script started ONE `worker-media` with its default queue list, which is all
three queues including `media.acquire` — and acquire refuses to boot at all
without a pinned downloader digest (`apps/worker-media/src/yt-dlp.ts`,
`EXPECTED_SHA256` is null on purpose). The whole process died at every boot,
silently, and took `media.probe` and `media.proxy` down with it: any newly
uploaded or repurposed video just sat at "queued" forever, while every health
check stayed green because nothing was listening on a port to fail. Logs:
`_orchestration/run-logs/production/worker-media.out.log` and
`worker-media-acquire.out.log`; pids in the matching `.pid` files next to them.

Why each env var is there, since removing one looks harmless and is not:

- **`WORKER_MEDIA_QUEUES`** is what makes the split work at all: the plain
  process never asks for the acquisition queue, so it never runs the digest
  check; the acquisition process asks for nothing else, so a probe/proxy job
  can never land on it. `media-pipeline.e2e-spec.ts` names its two queues for
  exactly this reason.
- **`WORKER_MEDIA_YT_DLP_VERIFY=0`** is the documented opt-out for a
  package-manager build, which is what this machine has: yt-dlp came from pip, so
  `yt-dlp.exe` is a ~108 KB launcher stub and the code lives in site-packages.
  Hashing the stub would be theatre. The **version** pin still applies and matches
  (2026.08.19). The container path keeps the real digest check —
  `apps/worker-media/Dockerfile` downloads the publisher's binary and
  `sha256sum -c`s it — so this opt-out is local, not a weakening of the image.
- **`YT_DLP_PATH`** must be the `.exe`. The digest check reads the file, and the
  bare name `yt-dlp` on PATH is a bash shim Node cannot spawn on Windows.

The **current release runs from `apps/web/.next-live-20260917c`**
(build `5mBDerBJ9_WM-HrxB7YE0`), published 2026-09-17 — Nocturne (§5) plus
every QA-pass fix through §12, including the four §11 fixes merged from
parallel isolated worktrees and reviewed before merge, the fifth (the
split-caption cache key) fixed straight after, and §12's session-refresh
fix on top of that. `api` (3913) was also restarted the same day, for the
Hinglish-native-script fix (§11's fourth bug, backend-only).

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

Retained for rollback, newest first: `.next-live-20260917b` (build
`FWCTJud6kCHKxtH4ES4WV`, all five §11 fixes but still with §12's
session-refresh cookie bug), `.next-live-20260917a` (build
`-6VACLt3sN0HjP2_1-qrc`, the first four §11 fixes but still with the
split-caption word-duplication bug), `.next-live-20260916f` (build
`892eaAltvsd5sT1njM0Rn`, the §8 QA-pass fixes but none of §9/§11),
`.next-live-20260916e` (build
`vxl0CO0wrlkRPKLQlmH83`, the credits-label and export-dialog-tab fixes from
§8, but still freezing a cancelled run's stage at "Add video" regardless of
how far it had gotten, and still losing a failed upload back into an
infinite retry-and-fail loop on Home — both also fixed in §8),
`.next-live-20260916d` (build
`6NPCBIaJf1JUxoJOUr6ZU`, the realtime-reconnect fix in §8 but still showing
"N credits left of 200" once N exceeds 200, and the export dialog's error
banner still bleeding across tabs), `.next-live-20260916c` (build
`6fMUXvjIqwUGBhH1D8xFV`, Nocturne with the contrast fixes and the workspace
switcher, but the realtime WebSocket client had no way to recover from an
expired access token — see §8), `.next-live-20260916b` (build
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

There is no reachable CI, and `git push` is not a deploy. Since 2026-09-19
`origin` is `github.com/dikshantbhatia09/aksharo`; verified batches of `main`
are pushed there (owner decision), after a secret scan of the commits. `docs/runbooks/deploy.md` describes an AWS EKS/ECR
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

## 5. Design system — **Shirorekha** (live since 2026-09-25)

The spec is `docs/redesign/DESIGN.md`; it wins over this summary. Per-area
screen maps and audits (with the product decisions they deferred) are in
`docs/redesign/map/`. It replaced **Nocturne** (blurple on blue-grey, outlined
primary button), which is gone: there is no `#9184d9`, `#161826` or outlined
primary in this product any more, and none of lime or mint either.

Aksharo is named for the akshar, the written syllable. The chrome is a quiet
warm charcoal so footage and words are the colourful thing on screen, and it
is signed in one place: the **shirorekha**, the bar Devanagari letters hang
from, drawn as a 32 × 3 px rani bar above each page title.

**Tokens** live in `packages/ui/src/styles/tokens.css` (Tailwind v4 `@theme`)
with a data copy in `packages/ui/src/tokens.ts`; `tokens.test.ts` pins the two
together and fails on pure black or white outside the caption defaults. They
are the ONLY legal source of colour/size — never a raw hex, never `white/NN`:

`bg-bg-0 #141217` (page) · `bg-surface #1f1c23` (cards) · `bg-bg-2 #2a262f`
(raised) · `bg-sunken #0e0c10` (rails, inputs, timelines) · `bg-ink #0b0a0c`
(the video canvas) · `text-fg-0 #f1ece6` · `text-fg-1 #d6cfc8` ·
`text-fg-2 #a39a93` · accent **rani `#f0508a`** with `accent-100…900`, and
warm `neutral-*` ramps · signals `proposed/warning #e8b04a`, `accepted #6fcf97`,
`rejected #ef7d4f`, `info #7fa6f5` · radii `rounded-sm` 6 · `md` 10 · `lg` 16.
Accent text is legal on `bg-0`/`surface`/`sunken` only; on `bg-2` use
`text-accent-300`. The `lime-*`/`mint*` variable names are historical and
resolve to the accent; do not rename them in passing.

Caption colours are a **different palette**: fill `#ffffff`, highlight
`#ffd400`, stroke `#000000`. Never use the accent as a caption colour.

**Rules that tests or reviewers will hold you to:**

- **`Button variant="primary"` is a rani fill with ink text, once per
  surface** (`primitives.test.tsx`). Everything else is `secondary`
  (outline) or `ghost`; `danger` is filled rejected.
- **Every page title is `<PageHeader>`** from `@montaj/ui` (eyebrow, title,
  description, actions). Nothing else carries the shirorekha bar — not cards,
  rows or dialog titles.
- **Anek Latin (`font-display`) is for page titles and large figures only**;
  Inter carries every control and all body text; JetBrains Mono for timecodes.
- The accent budget: one primary, the title bar, the active nav row, active
  tab, a switch that is on, a filled meter, a checked box, an unread dot, a
  selected card's ring. No accent headings, icons in lists, tinted cards or
  gradients. The only saturated field is the marketing stat band (`bg-section`).
- Inputs are `bg-sunken border-neutral-600` (a 4.25:1 control boundary);
  `border-border` is for cards and dividers.
- **Destructive actions that can't be undone go through `<ConfirmAction>`**
  (`@montaj/ui`): Cancel is focused first, the confirm button is named for the
  action. Reversible actions (archive, toggles) don't ask.
- `rule-fade` / `rule-fade-b` are plain hairlines now (the names are
  historical).
- A link inside an `<li>` that is navigation needs `no-underline`.
- Dark-only on purpose (a video tool). This is a recorded trade-off against
  Apple's "follow the system appearance", not an oversight.

**Shell.** Two widths, switched from the header and remembered per browser
(`components/shell/nav-model.ts`): a 68 px `NavRail` (default) and the 232 px
`Sidebar`. `PRIMARY_NAV` holds the eight destinations; the rest live in
`SECONDARY_NAV` ("More" in the sidebar, all of them in the command palette).
A disabled nav row is never "active".

The editor panel's row recipes live in
`apps/web/components/editor/panels/controls.tsx`. The three native controls
(`.panel-range`, `.panel-swatch`, `.panel-switch`) are in
`apps/web/app/globals.css` and must stay native elements — tests drive them
with `toHaveValue()` and `fill()`.

**Never remove a `data-testid`.** Unit tests and Playwright specs assert on them.

**Seeing the screens.** `apps/web/e2e/shirorekha-qa.spec.ts` captures every
signed-in screen at 1440 × 900 and 390 × 844 plus the editor, with an overflow
and console-error report; its header has the exact scratch-stack command. Two
things that cost time: run the **local** CLI
(`node node_modules/@playwright/test/cli.js test …`) — `npx playwright` picked
up a second Playwright on this machine and every spec failed to load with
"did not expect test() to be called here"; and set every port and origin,
because `playwright.config.ts` defaults to the production ports 3913/3914.

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

---

## 8. Found and fixed 2026-09-16 (a QA pass, clicking through the live site)

Seven bugs, found by using the product end to end as a logged-in user rather
than by reading the code. None of them showed up in a health check.

- **The home page pipeline banner showed a stage that was a full day stale.**
  `RepurposeService.get()` derives the visible stage from the source project's
  media and transcript, because nothing writes the run's own `status` column
  past `draft` for the early stages (§4.2's comment on `observedStatus` in
  `apps/api/src/repurpose/repurpose.service.ts`). `list()` — what the home page
  banner actually reads — never did that derivation, so it just showed the raw
  stored `status` forever. A run whose transcript had already landed still said
  "Add a video to get started" on the home page while its own detail page
  correctly said "Finding promising moments." Fixed by giving `list()` the same
  `observedStatus` pass `get()` already had; test in
  `apps/api/test/repurpose-runs.e2e-spec.ts` ("shows the same derived stage on
  the list as on the run's own page").
- **`worker-media` died at every boot, taking probe and proxy down with it.**
  Covered above in §1's worker-media block — the boot script started one
  process with the default queue list, which includes `media.acquire`, and
  acquire refuses to boot without a pinned downloader digest. Fixed by
  splitting into the two processes §1 now documents, baked into
  `start-production-stack.ps1` and `stop-production-stack.ps1` so a reboot
  cannot regress it.
- **The realtime WebSocket client could not recover from an expired access
  token.** `RealtimeClient.handleClose` (`packages/api-client/src/realtime.ts`)
  only refreshed the token on a post-handshake `4401` application close code.
  But a browser never sees the server's actual HTTP status when a WebSocket
  upgrade is refused outright — `realtime.gateway.ts` sends a plain 401 and
  destroys the socket for "no token" or "bad token" before the protocol ever
  completes, and the browser reports that as a generic abnormal closure, not
  4401. So a token that expired while a tab sat open retried unchanged on every
  backoff tick, forever, 401 after 401, because nothing ever asked for a new
  one. Fixed by also refreshing (best effort, not fatal if it fails — that
  branch does not know whether the real cause was an expired token or the
  server being briefly unreachable) whenever a connection attempt closes
  without `onopen` ever having fired. Tests in
  `packages/api-client/src/realtime.test.ts`.

- **The home page's credit count read "10000178 credits left of 200."** A
  workspace can carry an admin "adjustment" lot on top of its monthly grant —
  `settings/subscription` and `billing/usage` both draw these as separate
  "Grant" and "Adjust" lots, correctly. `ThisMonthCard`
  (`apps/web/components/home/this-month-card.tsx`) summed every lot into one
  balance and always framed it as "left of {grant}," so the moment a
  workspace has such a lot the balance can exceed the grant and the card
  reads like a broken counter even though the ledger is fine. Fixed to drop
  the denominator once `balance > grant`; test in
  `this-month-card.test.tsx`.
- **The export dialog's error banner bled across tabs.** Trying to export
  Video on an audio-only source (the bundled "Try with a sample" clip is
  `welcome.wav` — no video track, on purpose, `MediaService.attachSample`)
  correctly fails with "the source has no video track." But that banner is
  rendered once for the whole dialog, outside `TabsContent`
  (`ExportDialog.tsx`), and nothing cleared it on a tab change — so switching
  to Subtitles or To editor kept showing a video-specific error over a format
  that has nothing to do with video, before the reader had clicked anything
  there. The subtitle export itself was never actually blocked by it. Fixed
  by clearing dialog state on a tab switch whenever nothing is actually in
  flight (`!busy`), so an active render still survives a stray click.
  Verified live; not covered by an automated test — `ExportDialog.tsx` has no
  existing test file and stitching one together for a single-line behavioural
  change was not a good trade against the rest of this pass.

- **Cancelling an in-progress run always froze it at "Add video," no matter
  how far it had actually gotten.** `RepurposeService.cancel()`
  (`apps/api/src/repurpose/repurpose.service.ts`) froze the stage rail with
  `stageForStatus(run.status)` — the raw stored column, which never moves
  past `draft` for the early stages (the same fact `observedStatus`'s own
  comment explains). A run visibly on "Finding promising moments" when the
  person clicked Stop was still `status: "draft"` in the row, so it always
  came back as "Add video." Fixed to freeze on the same observed status the
  run's own page was showing; test in `repurpose-runs.e2e-spec.ts`.

- **A failed upload stayed stuck on Home forever, retrying and failing the
  same way on every page load, and Dismiss didn't actually get rid of it.**
  `UploadJob.fail()` (`apps/web/lib/upload/upload-job.ts`) set the in-memory
  status to `"error"` but never persisted that to the IndexedDB record every
  other terminal path (`cancel()`, the duplicate branch, a clean finish)
  persists or deletes. A record left at whatever non-terminal status the
  upload last saw is exactly what `listResumableUploads()`
  (`apps/web/lib/upload/store.ts`) offers back on the next mount, so a failed
  resume retried the same doomed request and failed the same way forever —
  observed live as an upload whose project had since been deleted, stuck
  showing "No such media." And `dismiss()` (`use-upload-queue.ts`) only ever
  cleared the in-memory row, never the record, so even clicking Dismiss
  brought it right back next load. Fixed both: `fail()` now persists the
  terminal status (test in `upload-job.test.ts`), and `dismiss()` deletes the
  record. Verified live — the actual stuck "vidssave.com" upload from an
  earlier session, gone for good after one Dismiss.

All seven were live in production before this pass and are fixed and deployed
as of `.next-live-20260916f` / API restart at the same time. One more thing
found and deliberately **not** touched: workspace `01M1KFX35NJRD5N58H0J6YGAPC`
(Dikshant Bhatia's) carries a balance of ~10,000,178 credits against a 200/mo
plan, from a single `kind: adjust, ref_type: grant` ledger row for
`+100,000,000` tenths on 2026-09-06. That reads like a deliberate "never run
out of credits while testing" grant, not corruption — the ledger is
consistent and every job settles correctly against it — so it was left alone.
If it was not deliberate, the fix is a new ledger entry, never touching or
deleting the existing rows.

**Also observed, not resolved at the time:** partway through this pass the
browser session signed itself out with "Your session ended" (the
`?reason=expired` copy `apps/web/app/(site)/login/login-form.tsx` shows when
`refreshSession()` returns null on mount). This looked at first like the
refresh-token reuse detector (`SessionService.refresh`,
`apps/api/src/auth/session.service.ts`) firing — the mechanism a second,
out-of-band caller hammering `/api/session/refresh` would plausibly trip. It
was not: `audit_log` has no `auth.refresh.reuse_detected` row anywhere near
the time, and the session's own row in `sessions` was neither revoked nor
near its (month-out) expiry. So the refresh cookie itself was gone or
stopped matching, for a reason this pass never pinned down. **Root-caused
and fixed 2026-09-17, see §12** — nothing to do with this browser tool
specifically; a real, user-facing bug in `app/api/session/refresh/route.ts`.

---

## 9. FIXED 2026-09-17 — Sarvam-routed transcripts had no real word timing

Found and diagnosed 2026-09-16 (kept undiagnosed overnight rather than guess
at a fix — this adapter's own docstring already records one bad guess at
Sarvam's wire shape that 400'd on every real call). Root-caused and fixed
2026-09-17 with one real, deliberately-authorised call against the live
Sarvam account.

**The bug.** Every word in every transcript routed to Sarvam (`provider:
"sarvam"`, the Hindi/Hinglish lane) had `s: 0, e: 0` — not approximately
zero, every single word, including the last one in an 8m58s file. Confirmed
on a real pre-existing project this pass never touched
(`01M2K1R52AANE4TH9RS5VH167D`, "Air India Phuket Turbulence Incident,"
transcribed 2026-09-14) as well as this pass's own test uploads. A
same-language project routed to `local-whisper` instead
(`01M2AT48M2ERZ8J1AX2DS3H667`) had completely normal timestamps — the bug was
specific to the Sarvam path, not to Hindi/Hinglish content. Since captions,
the timeline, word-highlighting and export all key off these timestamps,
this was not cosmetic: every Sarvam-routed project's captions were
effectively unusable for anything timing-dependent, and nothing about the
project ever said so — it sat at "Ready" like any other.

**Root cause, confirmed against the real vendor.** `providers/sarvam.py`
expected `payload.timestamps.chunks` — a list of `{text, start_time_seconds,
end_time_seconds}` objects — a shape whose docstring claimed it was "verified
live 2026-09-14," but that verification was not against `mode: codemix`, and
every real call this product makes is (`default_mode = "codemix"`, always,
per D12). One real call against the live account (with an explicitly
user-provided API key, for this diagnosis only, never written to a file or
committed) showed the actual codemix response:

```json
"timestamps": { "words": ["Alright, so here we are, one of the uh elephants..."],
                 "start_time_seconds": [0.0], "end_time_seconds": [19.07] }
```

Three **parallel arrays**, not a list of objects — confusingly keyed
`words` even though this call's one entry held the entire transcript
(chunk-grained, exactly as the docstring already said Saaras is; this is a
new envelope for the same thing, not new granularity). `_chunk_list()` found
none of `chunks`/`segments`/`diarized_transcript`, fell through to the
whole-file fallback, found no `duration_seconds` either, and produced one
segment spanning `(0, 0)` — collapsing every word in `ProportionalAligner`'s
zero-length-span branch. That is the exact, now-confirmed mechanism.

**The fix.** `_parallel_array_segments()` in `providers/sarvam.py` parses the
real shape directly (`apps/worker-ai/tests/test_vendor_adapters.py`,
`test_saaras_parses_the_parallel_timestamp_arrays_a_live_account_actually_sends`,
using the real captured response verbatim). `_chunk_list()`'s object-list
parsing stays as a fallback — not proven wrong, only proven not to be what
`mode: codemix` returns today — with its own test
(`test_saaras_still_reads_the_object_list_shape_as_a_fallback`) so a
regression there cannot hide behind the new path's tests passing. The
diagnostic warning from the first pass (`_seconds()`'s "no recognised
field" log) stays in place for whatever shape neither parser recognises.
Full suite: 906 passed. Deployed by restarting `worker-ai`.

**Verification note:** confirming this fix through the product's own UI
needed a genuinely uncached Sarvam call, and the same audio+language+
provider+model+mode combination this pass had already tested was still
sitting in the 30-day result cache from *before* the fix — so the ASR
result cache (`montaj:asr:v1:*` in Redis, 39 entries, all this session's own
test traffic) was cleared to force a real call rather than a replay. That
end-to-end confirmation then hit an unrelated, transient yt-dlp/YouTube
rate-limit ("Sign in to confirm you're not a bot") from re-fetching the same
test video too many times in one session — nothing to do with this fix, and
not chased further. The unit test against the real captured response is the
authoritative proof the parser is correct; the live confirmation was a nice-
to-have that a scraper-side rate limit got in the way of, not a gap in the fix
itself.

**Pre-existing corrupted data, confirmed not auto-repaired.** A later QA pass
(2026-09-17) reopened `01M2K1R52AANE4TH9RS5VH167D` ("Air India Phuket
Turbulence Incident") live and confirmed the corruption is still there end to
end, as expected — the fix only changes how a *new* Sarvam call is parsed, it
does not touch rows already written. `transcripts` for this project still
shows `created_at 2026-09-15` (before the fix); every one of its 194
`transcript_chunks` segments and all 2,193 words still carry `s:0, e:0` in
Postgres, and `toRenderProjection` (what the caption timeline and the export
engine actually consume) reproduces the same zero-width segments — confirmed
via `/export-harness`'s exposed `window.__exportHarness.projection`, not just
the DB. So exporting this project today renders a video whose captions are
still effectively frozen/invisible past frame 0. This is a data problem, not
a code defect: the only fix is re-running transcription (real Sarvam credits)
on this and any other project transcribed before 2026-09-17 on the Sarvam
path. Still awaiting a decision on whether to spend the credits to do that;
do not re-diagnose this project's broken caption timing as a new bug.

---

## 10. QA tooling note — the browser automation's own coordinate frame lies

Two false positives this pass (2026-09-17) turned out to be the same root
cause, not product bugs: a search-button click that "did nothing" on the
first try, and a right-panel tab (`Templates`) that stayed on `Text` no
matter how many times its button was clicked by screenshot coordinate or by
element `ref`. Both reproduced with `aria-selected` provably not changing —
not just a visual/timing miss. `document.elementFromPoint()` on the tab
button's own real `getBoundingClientRect()` center showed why: the page's
actual CSS viewport is far larger (`2400×1068`, `devicePixelRatio 0.8`) than
the screenshot buffer this tool returns (`1568×698`), so a coordinate read
off a screenshot and a `ref` resolved from the same stale layout both land
off-target on small elements — most visibly a ~66×38px tab strip button.
Calling `element.click()` directly (find the node by text/role, `.click()`
it) always worked and is unaffected by either scaling frame. When a click
"does nothing" in this environment, check `aria-selected`/`aria-pressed`
(or another concrete DOM signal) before concluding it is a product bug —
and prefer a JS-dispatched `.click()` over coordinate or `ref` clicks for
small targets.

---

## 11. FIXED 2026-09-17 — five bugs from a parallel QA sweep

Five independent QA agents, each in its own browser tab, swept upload/
new-project, YouTube repurpose, settings/billing, nav/command-palette/
responsive, and caption-editor-tools. Five confirmed bugs came back; four
were fixed immediately in isolated git worktrees by parallel fix agents and
merged after review, the fifth (the split-caption one) was fixed by hand
right after. All five are deployed as of `.next-live-20260917b` (API
restarted on the same code for the fourth one; web rebuilt twice the same
day, `a` then `b`).

- **An audio-only project's canvas preview said "Preview is preparing…"
  forever.** `apps/worker-media/src/processors/proxy.ts` intentionally never
  encodes a 540p proxy for a source with no video track
  (`if (facts.hasVideo)`), so `proxy` never appears on
  `GET /media/{id}/urls` for that project — not "not yet," never.
  `CaptionStage.tsx`'s own doc comment already admitted `src` is `undefined`
  for three different causes (audio-only / still transcoding / the fetch
  failed) but rendered one placeholder for all three, so an audio-only
  project (including "Try with a sample," which is exactly that) looked
  stuck loading for its entire life. Fixed with a `noMediaReason` prop
  (`"processing" | "audio-only" | "error"`, default `"processing"`) derived
  in `editor-client.tsx` from signals already on hand — no `width` on the
  primary media means the probe found no video track, a `urls` fetch error
  takes precedence over both — each with its own, honest copy. Tests in
  `caption-stage-transport.test.tsx` and `editor-client.test.ts`.
- **A brand-new, untouched project immediately nagged to "Reflow captions"**
  — the exact false positive `caption-budgets.ts`'s own doc comment says must
  never happen on first load. Not a logic bug: the real cause was
  `use-canvaskit.ts`'s `DEFAULT_FONTS` still naming Inter's old, pre-pack
  placeholder files (`Inter-Medium.ttf` etc., weights 400/500/900 only)
  instead of the real bundled pack's `inter-<weight>.ttf` faces (300–900,
  `packages/fonts/pack/`) that the *server's* budget measurement already
  uses. `vertical-clean` — the default style every fresh project opens on —
  asks for weight 600, which the browser had no exact face for, so
  `FontRegistry.resolve` silently substituted a different weight, measured a
  genuinely different fit, and disagreed with the server every time — not
  the ~1-character shaper noise `MAX_CHARS_TOLERANCE` exists to absorb.
  Fixed by correcting `DEFAULT_FONTS`' six Inter entries and adding them to
  `copy-render-assets.mjs`'s copy list (they were never being provisioned
  into `public/fonts/` at all). A sibling instance of the same stale-naming
  bug for Playfair Display/EB Garamond/Helvetica was found in the same file
  but left out of scope (follow-up task `task_efbfbb1e`).
- **The "N of {grant} left" broken-counter label** (originally fixed 2026-09-16
  on the Home page's `ThisMonthCard` only) **was never fixed in two sibling
  components** that render the same balance-vs-grant data: `/billing`'s
  Overview panel and the persistent sidebar credits widget
  (`components/shell/credits-card.tsx`). Same fix, same guard
  (`balance <= grant` before showing the denominator), applied to both.
- **The Native/EN script tabs in the caption transcript panel never changed
  the displayed text.** The frontend plumbing was already correct end to
  end — the bug was that `apps/api/src/transcripts/postprocess/pipeline.ts`'s
  Hinglish branch set `scripts.native = w.t` (the Latin text) whenever no
  genuine Devanagari source existed, which is exactly what happens when
  `local-whisper` transcribes Hindi speech straight into Hinglish/Latin text.
  `ScriptsService` then honestly reported "native" as available, and the
  editor rendered it — byte-identical to Roman, so the tab's own selected
  state visibly changed but the caption text never did, with no error
  anywhere because nothing failed. Fixed to only populate `scripts.native`
  (and only list "native" as available) when a real Devanagari string
  actually backs it; the script strip's existing on-demand transliterator
  (`ai.transliterate`) still produces a genuine one when a user clicks an
  unavailable tab. "EN" is a separate, pre-existing gap — there is no
  producer anywhere for word-level `scripts.en` (translation only writes
  segment-level `textOverrides.translated`), and `ScriptTabs.tsx` renders
  the EN tab as clickable regardless. Not folded into this fix; follow-up
  task `task_dba044f0`.
- **Splitting a caption briefly showed the split word duplicated in both the
  original and the new line, until the page was reloaded.**
  `TranscriptList.tsx`'s per-segment word cache was keyed on `segment.id`
  alone, invalidated only when the `wordsOf` callback's own identity
  changed. But `wordsOf` (`editor-client.tsx`) is memoized on `state.words`
  alone, and `SplitSegment`/`MergeSegments`/`Resegment` change a segment's
  `startWordId`/`endWordId` without touching the word index at all — so
  after a split, the just-trimmed segment's stale word list kept being
  served from cache, showing the split-off word(s) in both rows until a full
  remount rebuilt the cache from nothing. Fixed by keying the cache on
  segment id *and* its boundary ids, so a boundary change is a fresh key on
  its own without losing the cache's whole point (an unrelated segment
  mid-scroll still hits its existing entry). Test in the new
  `TranscriptList.test.tsx`, which fails against the pre-fix code and passes
  after.

**Not fixed, not a defect either — three unconfirmed observations from the
same sweep**, recorded so they are not re-investigated from scratch: (1) the
Home page's Spoken-language picker showed "English" while "Try with a
sample" produced an `hi-Latn` project — plausibly the sample clip is a fixed
demo regardless of the picker, not confirmed either way; (2) submitting the
YouTube-repurpose form with an (accidentally) empty link field coincided
with an unrelated toast and a credit-tick that could not be confidently
attributed to this session's own concurrent QA agents versus a real
validation gap — not reproduced in isolation; (3) a ~1–2s "Signed Out / 0
credits" flash on a fresh `/home` navigation, self-correcting with no
re-authentication needed — could not isolate a reliable trigger.

**The browser session signing itself out happened again** (see §8's "also
observed, not resolved" — this is the second time), this time in the main
session's own tab, immediately after the API process restart used to deploy
the Hinglish-native-script fix above. This time it was chased down — see
§12: the API restart briefly made `/auth/refresh` unreachable/erroring, and
`app/api/session/refresh/route.ts` treated that as proof the token was
dead.

---

## 12. FIXED 2026-09-17 — a transient `/auth/refresh` failure permanently
signed the user out

The single most severe bug found this session, and the third recurrence of
"the browser session signed itself out" (§8, then twice more in §11) —
except this time a fresh occurrence gave a hard data point (a live `401
auth/expired` from `/api/session/refresh` itself, not just a UI redirect)
that made it possible to actually root-cause instead of shrugging at it
again.

**The bug.** `apps/web/app/api/session/refresh/route.ts` — the Next.js
route the page calls because the refresh token is `httpOnly` and the
browser cannot read it — forwarded to the real API's `POST /auth/refresh`
and, on **any** `!upstream.ok`, cleared the 30-day session cookie and told
the client "Your session has ended." That is correct for a genuine `401`
(`SessionService.refresh` throws one, mapped to `HttpStatus.UNAUTHORIZED`,
for an unknown token, a revoked family, or a family past its absolute
lifetime — CONTRACTS §5) and wrong for everything else `/auth/refresh` can
answer with a non-2xx that has nothing to do with the token's validity:

- **A `429`** from this exact route's own IP rate limit
  (`auth:refresh:ip`, capacity 60, refills 1/sec — `auth.constants.ts`),
  tripped by ordinary concurrent traffic: several tabs (or, this session,
  several QA agents sharing one signed-in browser) each refreshing around
  the same time from the same apparent IP.
- **A `5xx`**, or a Cloudflare error page returned while `api` (3913) is
  mid-restart — `API_ORIGIN` is the public tunnelled hostname
  (`https://aksharo-api.crestmondtechnologies.com`), not a direct
  `127.0.0.1` call, so *any* restart of the API is a window where this
  round-trip can come back non-2xx for a reason with zero bearing on the
  refresh token.

Confirmed live, not guessed: the `sessions` row for the account this
happened to had `revoked_at` null and `expires_at` weeks out — the token
was never actually invalid. Only the one HTTP round-trip that checked it
was.

**The fix.** Only clear the cookie when `upstream.status === 401`. Every
other non-2xx now falls into the same branch the network-unreachable
`catch` already used: keep the cookie, answer `503
network/unreachable`, let the client retry. Test in the new
`app/api/session/refresh/route.test.ts` — the two new cases (`429`, `5xx`)
fail against the pre-fix code (both got turned into a cookie-clearing
`401`) and pass after.

**Why this matters beyond this session's own QA tooling.** Nothing about
the trigger is specific to browser automation: a real user behind a NAT
sharing an IP with other devices on the same refresh-heavy household or
office network, multiple tabs open at once, or simply refreshing during
the minute or two a deploy takes, would all have hit the exact same
permanent, unrecoverable sign-out — for a condition that resolves itself
within seconds if only the cookie had been left alone.

---

## 13. FIXED 2026-09-25 — every repurposed clip looped on "Checking this project…"

**Symptom.** Opening any clip a repurpose run had cut (the `… (9:16)` child
projects) showed a spinner and "Checking this project…" forever. The API log
showed the tab alternating `GET /projects/{id}/edg` and
`GET /projects/{id}/transcription-state` every 100–300 ms. Every clip that
existed (three) was affected, and no health check noticed.

**Root cause — three defects stacked.**

1. `RepurposeClipCompletionHandler` (`apps/api/src/repurpose/clip-completion.handler.ts`)
   cloned a transcript slice onto the child project but **never built its
   editing document** (`EdgService.initialise`), and stamped the mezzanine
   media `ready` **without probing it** (no width/height/fps, no proxy).
2. `transcription-state` answered `ready` as soon as a **transcript** row
   existed, without checking for the document the editor actually loads.
3. The waiting screen (`needs-transcription.tsx`) announced `ready`, the editor
   reloaded `/edg`, got `edg/not_initialised`, remounted the screen with fresh
   state (resetting its "announce once" guard) and asked again, forever. Its
   poll also swallowed every error silently.

**A fourth, found while repairing:** `media.clip` (`apps/worker-media/src/processors/clip.ts`)
writes the mezzanine to the **derived** store (the run's clip preview presigns
it from there) but reports the bucket it was *asked* for (`"s3"`), while
`media.probe`, `media.proxy` and the renderer read a primary asset from the
**raw** store only. Probing a clip therefore 404'd (`media/unreadable`).

**The fix (`1a1bf376`, `2d232165`, `e9b1f2d9`).**

- `TranscriptDocumentService.ensure()` builds a document from a transcript the
  project already has (no credits). `AutoTranscribeTrigger` calls it on
  `media.proxy` success for a project with a transcript and no document.
- The clip completion copies the mezzanine derived → raw (`promoteToRaw`, capped
  at 512 MiB), then sends it through the ordinary pipeline
  (`MediaService.completeAcquisition` → probe → proxy → document), *after*
  cloning the transcript so the proxy hook finds it.
- `transcription-state` says `ready` only when a document exists. A transcript
  without one reports an open job, waits on media still being prepared, sends
  never-probed media back through the probe (`MediaProbeRestart`, which waits
  out a full plan lane — `jobs/concurrency_cap`, Free allows 2 — rather than
  skipping it), or builds the document on the spot, and says `failed` rather
  than spin.
- Web: a second `ready` for the same project within 15 s shows "The editor could
  not open this project" with a retry instead of reloading again, and three
  failed polls show an error instead of the spinner.

**Invariant to keep:** *a project with a transcript has an editing document.*
Any new producer that writes a transcript must build the document too, or call
`TranscriptDocumentService.ensure()`. Checked live:
`select count(*) from projects p join transcripts t on t.project_id=p.id left join edg_documents d on d.project_id=p.id where d.id is null and p.deleted_at is null` → 0.

**Deploying without `nest build`.** `apps/api/nest-cli.json` has
`deleteOutDir: true`, so building the API inside `montaj-release` deletes the
running API's `dist/`. The 2026-09-25 deploys compiled with
`npx tsc -p tsconfig.build.json --outDir dist-<sha>` (identical file set to
`nest build`), and `_orchestration/tools/deploy-20260925{a,b,c}.ps1` stop only
the api (and web for `a`), swap `dist`, and restart; each has a matching
`rollback-*.ps1`. The workers were never restarted.

**Test hazard.** `apps/api/test/setup-env.ts` falls back to
`S3_ENDPOINT=http://localhost:9000`, bucket `montaj-raw` — on this machine that
is the **production** MinIO. The suites that upload use `montaj-e2e-minio`
(port 59000) and nothing was written, but a new e2e case must never `put` into
the store it gets from the app; fake `head`/`get` instead.

**Follow-up the same day (`2bc2f457`, `01f35008`, `a91a1a09`).**

- **Clips no longer have captions burned in.** `media.clip` used to draw the
  payload's `subtitles` into the mezzanine (Arial, white on black), which is the
  clip project's primary media — so the editor's captions and every export sat
  on top of a second, uneditable set, and the filmstrip showed text on every
  frame. The worker now cuts a clean picture (a legacy `subtitles` field is
  ignored), the API sends none, and the clip profile is `"2"`
  (`CLIP_PROFILE_VERSION`). The run page previews the clean clip with the clip
  project's own captions as a WebVTT `<track>` (`ClipPreview`, via the new
  `ApiClient.callText`) and offers "Open in editor".
- **Re-cutting a clip works.** `POST /repurpose/runs/{id}/clips` on a candidate
  that already has a clip re-cuts it; a completion whose checksum differs (or
  whose child media had failed) overwrites the raw copy and re-runs probe →
  proxy. The editing document is kept, so caption edits survive. The three
  existing clips were re-cut this way.
- **A clip's probe must run under the clip's project.** `completeAcquisition`
  queued the probe as a child of the `media.clip` job, and a child inherits its
  parent's project — the *source*. The worker builds the derived prefix from
  the job's project, so the proxy's keys landed outside the clip asset and the
  API's `assertOwnKeys` refused them (400). `enqueueChild` now takes a
  `projectId`, and `completeAcquisition` always passes the media's own.
- **Filmstrip thumbnails scale with duration**: one per half second, 10 to 32
  (`thumbnailCount`; 32 is the API's `MAX_THUMB_KEYS` — raise both together or
  every proxy write-back fails). Existing videos were backfilled with the
  worker's own code, not by re-encoding their proxies.
- **API-only deploys** now use `_orchestration/tools/deploy-api-swap.ps1
  -Sha <new> -PreviousSha <live>` (add `-Rollback` to undo), after building with
  `tsc --outDir dist-<sha>` as above.
