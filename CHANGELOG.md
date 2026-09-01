# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

- **A01 — Monorepo scaffold, tooling, CI, docker-compose, env.**
  - pnpm 9 workspaces (`apps/*`, `packages/*`, `plugins/*`, `engine/*`) driven by
    Turborepo 2, with cached `build`, `lint`, `typecheck`, `test`, `test:e2e`,
    `db:migrate` and `db:seed` tasks.
  - `@montaj/config`: strict TypeScript bases (ES2022, NodeNext, React), the shared
    ESLint flat config, the Prettier config and the Vitest preset; `BRAND` per
    CONTRACTS section 0; the credit burn-rate table as typed constants; a Zod schema
    for every variable in CONTRACTS section 1 with a fail-fast `loadEnv()`.
  - Package skeletons with a passing test and a README each: `edg`, `timemap`,
    `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`,
    `ass-exporter`, `api-client`, `ui`, `prompts`.
  - `apps/api`: NestJS 11 with `GET /health`, OpenAPI at `/docs` (JSON at
    `/docs-json`), a config module built on `loadEnv()`, an empty Prisma schema plus
    `prisma/sql/` for hand-maintained DDL, and a supertest e2e suite.
  - `apps/web`: Next.js 15 App Router, React 19, Tailwind v4 and shadcn/ui, with a
    placeholder page per route group (`(site)`, `(app)`, `(share)`, `(admin)`), a
    `/health` route handler and a Playwright smoke test on chromium and webkit.
  - `apps/worker-media`: BullMQ worker on `media.probe` with a stub processor and an
    ffmpeg/ffprobe boot check that refuses to start with clear install instructions.
  - `apps/worker-ai`: Python 3.12 project (pip-tools locks, ruff, `mypy --strict`,
    pytest, hypothesis) with a BullMQ worker on `ai.transcribe`, a FastAPI control
    app serving `GET /health`, and the abstract `Provider` interface.
  - `apps/render`: BullMQ worker on `render.video` with a stub processor.
  - README-only placeholders for `apps/desktop`, `apps/bridge`, `plugins/premiere-uxp`,
    `plugins/ae-cep`, `plugins/resolve` and `engine/montaj-engine`.
  - `docker-compose.yml`: Postgres 16, Redis 7 and MinIO with healthchecks, plus a
    one-shot `mc` bootstrap creating `montaj-raw` and `montaj-derived`; and
    `docker-compose.override.example.yml`.
  - `.env.example` covering all 31 CONTRACTS section 1 variables with local defaults.
  - GitHub Actions CI: TypeScript (Node 22), Python (3.12), a Playwright smoke lane
    and a `docker compose config` lane, with a concurrency group.
  - Repo hygiene: `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`,
    `.node-version`, `CODEOWNERS`, `LICENSE`, the pull-request Definition-of-Done
    template, and `docs/adr/0001-monorepo-tooling.md`.

[Unreleased]: https://github.com/aksharo/montaj/compare/main...HEAD
