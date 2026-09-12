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
cd apps/web && NEXT_DIST_DIR=.next-caption-live-20260912 NODE_ENV=production node --env-file=../../.env.local-run node_modules/next/dist/bin/next start --port 3914
```

The caption-editor release published on 2026-09-12 runs from
`apps/web/.next-caption-live-20260912` (build `fzstBbkQAwLxfxTeVNKtz`).
Set `NEXT_DIST_DIR` as shown when restarting this release; `.next` contains
the previous build retained for rollback. Deployment details are in
`scratch/caption-live-deployment.json`. A future build should use a new output
directory while the live process is running, then switch the web service to it.

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
pnpm --filter @montaj/web lint             # baseline is 13 PRE-EXISTING errors
                                           # (CaptionStage.tsx + qa-sweep/*) — do not
                                           # "fix" them, just do not add more
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
  no existing transcript or edg document, and the workspace has credits. A
  brand-new Free workspace is created with **0 credits and 0 monthly grant**, so
  on a fresh test account the upload succeeds and transcription silently never
  starts. That is not an upload bug.
- **The Free plan cap is 500 MB / 20 min.** The size cap is enforced at `init`;
  the duration cap only after probing.

Diagnosing without guessing: `access_logs` (per workspace) shows whether the
browser reached the API at all. No `project.create` row means the failure was
**client-side, before any request** — look at the file picker, the Prepare Media
modal and hashing, not at the server.

---

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
