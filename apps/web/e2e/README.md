# `apps/web/e2e` — Playwright suite

Chromium + WebKit, driven by `apps/web/playwright.config.ts`. `env.ts`'s
`loadRepoEnv()` reads the nearest `.env` walking up from the process's
working directory, the same way the API's own `loadRepoDotenv()` does — so
the suite always sees the ports, database and secrets of whichever
worktree's `.env` it is run from, real environment variables overriding the
file.

## Running a subset against a worktree-specific `.env`

Every work package runs in its own worktree (`05-build/_worktrees/<WP>`)
with its own `.env` — its own `DATABASE_URL` (`montaj_<wp>`), `API_PORT` /
`WEB_PORT`, and origins. Running the suite from inside that worktree picks
up that `.env` automatically; the two things to get right when you only want
one spec or one browser:

```
# One spec, one browser, from the worktree's apps/web directory:
pnpm exec playwright test e2e/editor.spec.ts --project=chromium

# The whole suite, one browser (faster iteration; both browsers still gate
# the final pass — see docs/PLAN.md's wave sub-order and this suite's own
# gate-a.spec.ts):
pnpm test:e2e -- --project=chromium

# Both browsers, one spec — the shape a final pre-commit check should take:
pnpm test:e2e e2e/gate-a.spec.ts
```

If a second worktree's API happens to be running on the same machine, make
sure the `.env` this run resolves to (`loadRepoEnv`'s walk-up) is the one you
mean to test against — a `playwright test` invoked from the wrong directory,
or with `API_PORT`/`WEB_PORT` exported in the shell from a different
worktree's session, silently talks to someone else's stack. `API_ORIGIN` /
`WEB_ORIGIN` printed at the top of a run's `webServer` output are the
fastest way to confirm which one actually got picked up.

`fixtures.ts`'s Redis reads (the dev-mail outbox) are namespaced by
`MONTAJ_REDIS_PREFIX` the same way the API's own keys are
(`apps/api/src/common/redis/redis-keys.ts`) — set to this worktree's id in
its `.env`, so two worktrees sharing one Redis never read each other's
outbox messages. See `env.ts`'s `redisKeyPrefix()` and its test,
`env.test.ts` (run with `pnpm exec tsx --test e2e/env.test.ts` — a
`node:test` file, not a Playwright spec or a Vitest one; see that file's own
header for why).

## Fixtures and simplifications

- `fixtures.ts` — sign-up, sign-in, the dev-mail outbox, axe.
- `fixtures-media.ts` — a small real WAV file, generated in Node (no
  `ffmpeg` dependency), for the upload suite.
- `editor-fixtures.ts` — seeds a real editor project by driving the real
  `POST /transcribe` → signed completion-callback path, not by writing an
  EDG document by hand.
- `internal-callback.ts` — the signed worker → API completion callback
  (CONTRACTS §3), used throughout the suite as the documented stand-in for a
  running `apps/worker-media` / `apps/worker-ai` process.
- `gate-a.spec.ts` — the Gate A journey (`docs/PLAN.md`): sign-up through
  onboarding, upload, transcription, editing, style, SRT + browser MP4 +
  cloud-render export, and reload persistence. Its own header lists the
  same test-environment simplifications as the rest of the suite.

### What a journey has to do before it can upload or transcribe (S-07)

Three preconditions the product now enforces. A spec that skips one does not
fail with a helpful message — it hangs on a tray row that never moves, which
is exactly how `upload.spec.ts` and `gate-a.spec.ts` came to be red at base.

- **Pick a language in "Prepare Your Media" after `dropFile` (F04, moved into
  the modal by K02).** The funnel ends in a paid transcription, so a single
  file dropped opens the `prepare-media-modal` dialog and does not upload
  until `Generate Transcription` is used — that button stays disabled without
  an explicit language (`home-view.tsx`'s `PrepareMediaModal` wiring;
  `prepare-media-modal.tsx`). Every journey opens the dialog, clicks
  `quick-pick-language-trigger`, then `quick-pick-language-hi-Latn` inside it,
  then `prepare-media-generate` (see `upload.spec.ts`/`gate-a.spec.ts`'s
  `prepareAndUpload` helper). Two or more files at once still goes through the
  old pre-drop gate on the quick-pick row instead (`BatchApplyToAllSheet`'s
  path, unchanged). A project that does reach the server without a language is
  what the read model calls `awaiting_language`, and its tray row reads
  "Needs attention — open the project".
- **Grant credits before anything that transcribes or renders (B01).** A
  freshly signed-up workspace has a real, enforced **zero** balance: its first
  monthly grant comes from a scheduled job that `playwright.config.ts` turns
  off (`MONTAJ_SCHEDULER_DISABLED=1`), so `POST /transcribe` answers 402
  `credits/insufficient`. `export-test-helpers.ts`'s `grantTestCredits(workspaceId)`
  is the one way to fix that: 200 tenths (the same 20 credits `prisma/seed.ts`
  gives the demo workspace) written as `credit_accounts` + `credit_lots` +
  `credit_ledger` **together** by SQL through `pg`, because the ledger's drift
  check refuses a hold when those three disagree — the same three statements
  `scripts/local-ai-smoke.mjs`'s `grantCredits()` uses for manual QA.
  `gate-a.spec.ts`, `export.spec.ts` and `export-fallback.spec.ts` all call it
  right after sign-up; `workspaceIdFromPage(page)` resolves the id from the
  page's own `POST /api/session/refresh`. `upload.spec.ts` deliberately does
  **not**: nothing in it reaches a paid operation, because with no worker
  running the media never leaves `uploaded` and `/transcribe` stops earlier, at
  409 `transcript/media_not_ready`.
- **Do not wait for the upload row to say "ready" (F03).** Since F03-5
  (`37d081c`) `upload-job.ts` never sets `ready`: when the bytes are up it sets
  `processing` (or `transcribing`) and the server pipeline owns the row from
  there. So `upload-cancel` never disappears and `upload-dismiss` never
  appears (`upload-tray.tsx:200-225` renders Cancel for every status that is
  not `ready | error | cancelled | duplicate`). The settle signal is
  `upload-tray-pipeline-status`, which the tray mounts only for a
  `serverOwned()` row — see `expectUploadSettled()` in `upload.spec.ts` and
  `gate-a.spec.ts`.

### Running `gate-a.spec.ts` (M18)

Run it exactly like any other spec — `pnpm exec playwright test
e2e/gate-a.spec.ts --project=chromium --workers=1` from this worktree's
`apps/web`, against `playwright.config.ts`'s own locally-spawned `api`/`web`
(**not** the full `docker-compose.test.yml` stack, and specifically **not**
with `apps/worker-media`, `apps/worker-ai` or `apps/render` also running
against this worktree's queue prefix**):

- **Harness mode is fixed, not a per-run choice**: the spec drives probe,
  proxy, transcription, subtitle-render and video-render entirely through
  `internal-callback.ts`'s signed `completeJobForTest` (CONTRACTS §3) — the
  same "API-side test hook" the rest of the suite uses in place of a running
  worker (see the spec's own file header). If a real `worker-media` /
  `worker-ai` / `apps/render` process is also consuming jobs on this
  worktree's `MONTAJ_QUEUE_PREFIX`, it races the spec's own
  `expect(probeJob).toBeDefined()` / `completeJobForTest` calls — that raced
  probe assertion is what several Gate B run notes flagged as a harness
  ambiguity; it was never one, the fix is to not start those workers for this
  spec.
- The spec needs `ffmpeg`/`ffprobe` on `PATH` (it builds a real vertical MP4
  fixture and probes the downloaded cloud-render output) and a real MinIO at
  `S3_ENDPOINT` for the real multipart upload and the fabricated
  sidecar/render-output uploads.
- One retry outside CI (`playwright.config.ts`) absorbs the shared dev-mail
  outbox losing a signup's confirmation email to a concurrent worktree's own
  traffic (see that file's comment) — not a gate-a-specific flake.

## Full compose-stack run

`pnpm e2e:stack up` (repository root) brings up the fuller stack —
`docker-compose.test.yml`'s api/web/worker-media/worker-ai/render, migrated
and seeded — for a run closer to production than the locally-spawned
processes `playwright.config.ts`'s own `webServer` entries use for speed.
`pnpm e2e:stack down` tears it back down. `scripts/verify-wave.mjs` runs
this as part of a full wave gate.
