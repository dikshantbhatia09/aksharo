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
cd apps/web && NEXT_DIST_DIR=.next-live-20260915c NODE_ENV=production node --env-file=../../.env.local-run node_modules/next/dist/bin/next start --port 3914
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

The **current release runs from `apps/web/.next-live-20260915c`**
(build `BW5EXx1_ZNWmleSPfNRYL`), published 2026-09-15. Set `NEXT_DIST_DIR` to
that directory when restarting the web service, or the restore command brings
back an older build.

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

Retained for rollback, newest first: `.next-live-20260915b` (build
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

## 5. Design system

Tokens live in `packages/ui/src/styles/tokens.css` (Tailwind v4 `@theme`), and
are the ONLY legal source of colour/size. Use the utilities, never raw hex and
never `white/NN`:

`bg-bg-0 #0b0b0e` · `bg-bg-1 #131318` · `bg-bg-2 #1b1b22` · `border-border #2a2a33`
`text-fg-0 #f5f5f7` · `text-fg-1 #c9c9d1` · `text-fg-2 #8b8b96` · `text-fg-disabled #5c5c66`
accent `lime-500 #d8ff3d` (hover `lime-600`), `text-on-accent`
signals `proposed / accepted / rejected / info / warning`
radii `rounded-sm` 8px · `rounded-md` 12px · type `text-2xs` 11 / `text-xs` 12 / `text-sm` 14

Caption colours are a **different palette** from chrome: fill `#ffffff`,
highlight `#ffd400`, stroke `#000000`. Never use the brand lime as a caption colour.

**Accent discipline:** lime is only for the active tab underline, a switch that
is ON, a slider's filled track, the tinted accent tone on an active toggle
(`border-lime-500/45 bg-lime-500/12 text-lime-500`), a selected card's ring, and
at most one primary button per surface.

The editor panel's row recipes live in
`apps/web/components/editor/panels/controls.tsx` — copy them rather than
inventing new ones. The three native controls (`.panel-range`, `.panel-swatch`,
`.panel-switch`) are in `apps/web/app/globals.css` because they need
pseudo-elements; they must stay native elements because tests drive them with
`toHaveValue()` and `fill()`.

**Never remove a `data-testid`.** Unit tests and Playwright specs assert on them.

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
