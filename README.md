# Montaj (codename) — Aksharo

Monorepo for the Aksharo platform. `montaj` is the engineering codename only:
repo folder, `@montaj/*` package scope, queue names. Brand strings live in one
file, `packages/config/src/brand.ts` (`docs/CONTRACTS.md` section 0).

## Setup

Requires **Node 22 LTS** (`.nvmrc`, `.node-version`), **pnpm 9.15.9**, **Python 3.12**, **Docker**, and **ffmpeg** on `PATH` (authoritative schema: `toolchain.json`).

> [!IMPORTANT]
> **Release Toolchain Policy (RLS-003):** Tests run under unpinned toolchains (e.g. Node 24, pnpm 11, Python 3.13) **cannot be accepted as release evidence**.
> Do not mutate `pnpm-lock.yaml` to match a local host. To develop in an isolated, guaranteed toolchain, use the pre-configured [Devcontainer](docs/DEVCONTAINER.md) (`.devcontainer/`).

### Quick Start with Bootstrap

```bash
# Windows PowerShell (automated Node 22 / pnpm 9.15.9 / venv bootstrap):
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1

# POSIX / macOS / Linux:
./scripts/bootstrap.sh

# Cross-platform / existing Node:
node scripts/bootstrap.mjs
```

### Manual Setup & Verification Gate

```bash
# 1. Enable Corepack & pinned pnpm 9.15.9
corepack enable && corepack prepare pnpm@9.15.9 --activate

# 2. Run the Toolchain Preflight Gate (fails fast with actionable remediation if mismatched)
pnpm preflight

# 3. Install dependencies from frozen lockfile
pnpm install                       # bootstraps apps/worker-ai/.venv on first run

# 4. Configure local environment and start backing services
cp .env.example .env               # fill in secrets; defaults match the compose stack
docker compose up -d               # postgres, redis, minio + both buckets
pnpm db:migrate && pnpm db:seed    # no-ops until A03 lands the schema
pnpm dev                           # api :3001, web :3000, workers
```

Verify with `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, then
`pnpm --filter @montaj/web test:e2e` (run `test:e2e:install` once first).
`docker compose down -v` tears the stack down.

## Layout

| Path                          | What                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                    | Next.js 15 studio + marketing site — route groups `(site)`, `(app)`, `(share)`, `(admin)`                                                          |
| `apps/api`                    | NestJS modular monolith + Prisma; OpenAPI at `/docs`                                                                                               |
| `apps/worker-media`           | Node BullMQ + ffmpeg: probe, audio, proxies, waveform, thumbs                                                                                      |
| `apps/worker-ai`              | Python 3.12 BullMQ worker: providers, VAD, alignment, passes, LLM                                                                                  |
| `apps/render`                 | Skia (`@napi-rs/canvas`) frame renderer + ffmpeg encode                                                                                            |
| `apps/desktop`, `apps/bridge` | Electron shell and local bridge (deferred post-launch surfaces, absent from HEAD — see Wave C and docs/audit/RLS-004-DEAD-SURFACE-INVENTORY.md)    |
| `plugins/*`                   | Premiere UXP, After Effects CEP, DaVinci Resolve script (deferred post-launch surfaces, absent from HEAD — see Wave C)                             |
| `apps/engine`                 | Native local engine sidecar (`montaj-engine`) (deferred post-launch surface, absent from HEAD — see Wave C)                                        |
| `packages/*`                  | `edg`, `timemap`, `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`, `ass-exporter`, `api-client`, `ui`, `prompts`, `config` |
| `docs/`                       | `PLAN.md` (waves and status), `CONTRACTS.md` (frozen interfaces), `THREAT-MODEL.md`, `adr/`                                                        |

## Working here

Read `docs/PLAN.md` for what is in flight and `docs/CONTRACTS.md` before touching
any shared type — those interfaces are frozen and change only through an ADR.
`10-build-plan.md` section 2 has the engineering conventions and the Definition of
Done, which is also the pull-request checklist.

### Formatting

**Use `pnpm format:changed`, not `pnpm format`.**

`pnpm format` rewrites every file in the repository. Several work packages run at
once, each in its own worktree, so a repo-wide rewrite drags dozens of files
nobody touched into the diff — and every one has then had to be reverted by hand
before the commit. `pnpm format:changed` runs Prettier over exactly what this
branch changed: everything that differs from the merge base with `main`
(`git diff --name-only main...HEAD`, so a merged-in `main` does not count), plus
whatever is uncommitted, staged or not, new files included.

```bash
pnpm format:changed          # rewrite this branch's files
pnpm format:changed:check    # fail if any of them is unformatted
pnpm format:changed -- --base release/1.2   # compare against something else
```

`pnpm format` and `pnpm format:check` still exist for the one job they are right
for: a deliberate, reviewed, repo-wide reformat after a Prettier upgrade. Never
leave a file that fails `format:changed:check`, and never reformat a file outside
your work package unless a merge conflict forced you into it.

All four scripts run Prettier through `node --max-old-space-size=6144 …` (A18a-b): the repo-wide glob in `format`/`format:check` runs Node out of the default heap on some hosts and fails with no output at all — `--max-old-space-size` fixes it without a new dependency (`cross-env` is not in the tree, and `node --max-old-space-size` is the same flag on every OS this repo targets, so no shell-specific env-var syntax is needed).

## Scripts

| Command                                                | Does                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm preflight`                                       | Validate supported build toolchain (Node 22, pnpm 9, Python 3.12, FFmpeg, Docker)  |
| `pnpm bootstrap`                                       | Cross-platform bootstrap script to prepare pinned toolchain & .env                 |
| `pnpm dev`                                             | every app in watch mode                                                            |
| `pnpm build` / `lint` / `typecheck` / `test`           | across the workspace (Python included)                                             |
| `pnpm test:e2e`                                        | Playwright (chromium + webkit) and the API e2e suite                               |
| `pnpm format:changed`                                  | Prettier over this branch's files (use this one)                                   |
| `pnpm format:changed:check`                            | the same set, checked rather than rewritten                                        |
| `pnpm format`                                          | Prettier over the **whole repo** — see Formatting                                  |
| `pnpm db:migrate` / `db:seed`                          | Prisma migrations and seed                                                         |
| `node scripts/ops/restore-drill.mjs`                   | Backup restore drill against the compose stack (`docs/runbooks/backup-restore.md`) |
| `node scripts/ops/dpdp-records-generate.mjs [--check]` | Regenerate/verify `docs/compliance/dpdp-records.md`                                |

## Operations

- **Status page:** `/status` (public), fed by `apps/api/src/ops/status.controller.ts`'s
  `GET /ops/status.json`, published every 5 minutes by the `status-publish`
  scheduler task. Incidents are managed at `POST/PATCH /admin/ops/incidents`.
- **Runbooks:** `docs/runbooks/` — see `on-call.md` for the alert-to-runbook
  index, `backup-restore.md` for backups and the restore drill, and
  `breach-pipeline.md` for the two regulatory notification clocks (DPDP 72 h,
  CERT-In 6 h).
- **Compliance:** `docs/compliance/dpdp-records.md` (generated — see the
  script table above) is the DPDP record of processing activities.

## Licence

Proprietary — see [LICENSE](LICENSE).
