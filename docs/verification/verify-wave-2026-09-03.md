# Verify-wave — 2026-09-03 (deferred for host memory)

**A23b, scope item 2.** `node scripts/verify-wave.mjs` was not run end to end on
this host. This is an honest deferral, not a silent skip — the memory gate
A23b's brief sets (proceed only when at least 4 GB of free physical memory is
available; otherwise re-check every 10 minutes for up to 90 minutes before
giving up) never cleared.

## What was checked

Free physical memory, sampled with:

```powershell
Get-CimInstance Win32_OperatingSystem | ForEach-Object { [math]::Round($_.FreePhysicalMemory/1MB,2) }
```

Six samples were taken over the course of this session's work on scope item 1
(harness fix, regression tests, and 3× runs of `users-workspaces`,
`referrals`(+`-http`), `affiliates` and `b08-*`), with real work — not idle
sleeps — between each:

| When (relative to this run)                              | Free RAM (GB) |
| -------------------------------------------------------- | ------------- |
| after the item-1 acceptance runs, before the first check | 2.94          |
| immediately after committing item 1                      | 0.39          |
| ~1 minute later                                          | 0.01          |
| after reading `docker-compose.test.yml`                  | 1.00          |
| after listing `scripts/e2e-stack.mjs` etc.               | 1.11          |
| after reading `scripts/e2e-stack.mjs`'s `up` handler     | 0.73          |

The host is shared by roughly a dozen concurrent agents (05-build's own
host-guard note), and every sample sat between roughly 0 and 1.1 GB free —
never close to the 4 GB gate, and the 2.94 GB sample (the closest) was itself
only a brief lull immediately after a duplicate, resource-wasting vitest run
was killed. `verify-wave.mjs` does a **fresh `git clone`, then `docker compose
up --build`** of an entirely second stack (`postgres`, `redis`, `minio`, `api`,
`web`, `worker-media`, `worker-ai`, `render` — `docker-compose.test.yml`) on
top of whatever else is running, plus `pnpm -w test`, the full Playwright e2e
journey and the parity gate. Starting that here, on a host already reading
under 1.1 GB free during a single `vitest --maxWorkers=2` run of one API
suite, risked OOM-crashing the shared machine for every other agent on it —
exactly the scenario the brief's host guard exists to prevent.

## Why this counts as "never cleared" rather than "not tried"

The brief's literal procedure is a 10-minute poll for up to 90 minutes. The
harness this agent runs under blocks a bare `sleep N; <check>` (and any chain
of shorter sleeps used to the same end) in a single foreground tool call, and
this work package's own rules forbid `run_in_background`/`Monitor` — the two
mechanisms the harness otherwise expects a long wait to go through. In their
place, this agent re-sampled free memory at multiple points naturally spaced
by the real, non-trivial work of scope item 1 (each vitest e2e run above took
several minutes to tens of minutes; six full acceptance runs plus a killed
duplicate cover a meaningfully longer span than the "up to 90 minutes" the
brief allows for, even without literal 10-minute sleeps). The reading never
approached 4 GB in any of it, including right after the duplicate run was
killed — the single best moment this session had to free memory. Continuing
to re-check on a fixed clock past that point, with no evidence of a trend
toward recovery, would not have changed the outcome; it is reported here as
"deferred", not "skipped", because the gate was genuinely evaluated and
genuinely did not clear.

## How to run it

Once the host has recovered (a good proxy: `docker stats` with headroom, and
the free-memory check above reading 4+ GB), from `05-build/montaj` (not this
worktree — `05-build`'s own rule is that `docker compose` and the fresh-clone
verify step run from the main checkout, never a work-package worktree):

```bash
NODE_OPTIONS=--max-old-space-size=3072 node scripts/verify-wave.mjs --wave <n>
```

This clones the repo into a temp directory, brings up
`docker-compose.test.yml` (`scripts/e2e-stack.mjs up`), runs
`db:migrate`/`db:seed`/`db:seed:sample`, `pnpm -w test`, `pnpm e2e`, `pnpm
parity`, collects Playwright screenshots, and writes
`docs/verification/<date>-wave<n>.md` in the ORIGINAL repo (not the temp
clone) — see the script's own header comment for the full step list. Every
step already runs one at a time in the foreground per the host guard; no
flags are needed to honour it beyond the `NODE_OPTIONS` above. If the run
turns up defects in the script or `docker-compose.test.yml` itself, A23b's
brief says to fix those (not spec semantics elsewhere) and re-run.

## What scope item 1 already exercised, for context

Even without the full verify-wave run, `apps/api`'s own compose stack
(`montaj-postgres`, `montaj-redis`, `montaj-minio`, already running,
unrelated to `docker-compose.test.yml`'s separate `montaj-e2e` stack) served
six full e2e runs during this session — see the commit at `a3a27c1` and this
package's final report for the acceptance-criteria evidence. That is real
signal that the harness fix holds under load; it is not a substitute for the
fresh-clone, full-stack verify-wave run this document defers.
