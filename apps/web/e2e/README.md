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

## Full compose-stack run

`pnpm e2e:stack up` (repository root) brings up the fuller stack —
`docker-compose.test.yml`'s api/web/worker-media/worker-ai/render, migrated
and seeded — for a run closer to production than the locally-spawned
processes `playwright.config.ts`'s own `webServer` entries use for speed.
`pnpm e2e:stack down` tears it back down. `scripts/verify-wave.mjs` runs
this as part of a full wave gate.
