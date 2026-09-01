# Montaj (codename) — Aksharo

Monorepo for the Aksharo platform. `montaj` is the engineering codename only:
repo folder, `@montaj/*` package scope, queue names. Brand strings live in one
file, `packages/config/src/brand.ts` (`docs/CONTRACTS.md` section 0).

## Setup

Requires **Node 22** (`.nvmrc`), **pnpm 9**, **Python 3.12**, **Docker** and
**ffmpeg** on `PATH`.

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install                       # also bootstraps apps/worker-ai/.venv on first test run
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
| `apps/desktop`, `apps/bridge` | Electron shell and the local bridge (README only until C01/C02)                                                                                    |
| `plugins/*`                   | Premiere UXP, After Effects CEP, DaVinci Resolve script (README only)                                                                              |
| `engine/montaj-engine`        | native local engine (README only until C03a)                                                                                                       |
| `packages/*`                  | `edg`, `timemap`, `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`, `ass-exporter`, `api-client`, `ui`, `prompts`, `config` |
| `docs/`                       | `PLAN.md` (waves and status), `CONTRACTS.md` (frozen interfaces), `THREAT-MODEL.md`, `adr/`                                                        |

## Working here

Read `docs/PLAN.md` for what is in flight and `docs/CONTRACTS.md` before touching
any shared type — those interfaces are frozen and change only through an ADR.
`10-build-plan.md` section 2 has the engineering conventions and the Definition of
Done, which is also the pull-request checklist.

## Scripts

| Command                                      | Does                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                   | every app in watch mode                              |
| `pnpm build` / `lint` / `typecheck` / `test` | across the workspace (Python included)               |
| `pnpm test:e2e`                              | Playwright (chromium + webkit) and the API e2e suite |
| `pnpm format`                                | Prettier over the repo                               |
| `pnpm db:migrate` / `db:seed`                | Prisma migrations and seed                           |

## Licence

Proprietary — see [LICENSE](LICENSE).
