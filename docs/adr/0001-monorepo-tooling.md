# ADR 0001 — Monorepo tooling: pnpm workspaces, Turborepo, and one toolchain package

- **Status:** Accepted
- **Date:** 2026-09-02
- **Work package:** A01
- **Deciders:** Fable 5.1 (design), Opus 5 agent (implementation)
- **Supersedes / superseded by:** —

> **ADR template.** Copy this file to `docs/adr/NNNN-<slug>.md` for the next
> decision and keep the same headings. Every deviation from `03-architecture/`
> needs one (`10-build-plan.md` section 2). Numbering is sequential and permanent;
> a reversed decision gets a **new** ADR that supersedes the old one rather than
> an edit.

## Context

`03-architecture/05-system-architecture.md` section 1 fixes the stack: pnpm
workspaces + Turborepo, Next.js 15, NestJS + Prisma + Postgres 16 + Redis 7 +
BullMQ, a Python 3.12 AI worker, a Skia render service, Electron, and three host
plugins. `10-build-plan.md` section 1 fixes the folder layout.

That leaves A01 with the questions the architecture does not answer:

1. Fourteen-plus packages will be written **in parallel by separate agents**, each
   seeing only its own brief. Anything not enforced mechanically will diverge —
   lint rules, `tsconfig` strictness, test conventions, credit units.
2. The repository mixes **TypeScript and Python**. One command has to run both, on
   Windows and on Linux, or the Python gates will quietly stop being run.
3. Fifteen work packages must be able to run their own `build`, `lint`, `typecheck`
   and `test` without a full-repo rebuild each time.
4. Contract drift between the Node and Python sides (queue names, environment
   variables) would surface as an empty queue in production rather than as a test
   failure.

## Decision

**1. pnpm 9 workspaces with Turborepo 2.**
`packageManager: "pnpm@9.15.9"` — the exact resolution of the `latest-9` tag, since
Corepack requires a concrete version. Globs: `apps/*`, `packages/*`, `plugins/*`,
`engine/*`. Turbo tasks are `build`, `dev`, `lint`, `typecheck`, `test`, `test:e2e`,
`db:migrate` and `db:seed`; `build` declares `dependsOn: ["^build"]` with `dist/**`
and `.next/**` outputs, and the pass/fail tasks declare no outputs so the cache
stores only their exit status.

**2. One toolchain package, `@montaj/config`, exporting configuration as subpaths.**
`./tsconfig.base.json`, `./tsconfig.node.json`, `./tsconfig.react.json`, `./eslint`,
`./prettier`, `./vitest`. Every package extends them rather than copying them. It
also owns the three cross-cutting constants — `BRAND`, the credit burn-rate table
and the environment schema — because each of those has exactly one correct value
and many consumers.

**3. CommonJS output, NodeNext resolution, `strict` plus `noUncheckedIndexedAccess`.**
Targets ES2022. NestJS, the Node workers and Vitest all consume CJS without an
interop layer; `apps/web` overrides to `ESNext` + `Bundler` because Next.js requires
it. Type-aware ESLint rules are deliberately **off**: `pnpm typecheck` owns type
errors, which keeps `pnpm lint` fast and independent of build order.

**4. Vitest everywhere for units, Playwright for browser e2e.**
`apps/api` runs Vitest through `unplugin-swc` because NestJS DI reads
`emitDecoratorMetadata`, which esbuild cannot emit. Playwright runs **chromium and
webkit** as equal, blocking lanes.

**5. Python is a first-class workspace member behind a Node bridge.**
`apps/worker-ai` carries a `package.json` whose scripts call `scripts/py.mjs`, which
finds (and on first use creates) `apps/worker-ai/.venv` and runs ruff, mypy or pytest
inside it. Dependencies are declared exactly-pinned in `pyproject.toml` and locked
with pip-tools into `requirements.lock` and `requirements-dev.lock`.

**6. Cross-language contracts are asserted by tests, not by convention.**
`packages/config/src/env.test.ts` parses `.env.example`; the Python
`tests/test_settings.py` parses `packages/config/src/env.ts`; `tests/test_queues.py`
parses `apps/worker-media/src/queues.ts`. Adding a variable to CONTRACTS section 1
or renaming a queue on one side fails CI on the other.

## Consequences

**Good**

- A shared lint or compiler rule is a one-file change that applies repo-wide.
- `pnpm test` at the root covers TypeScript _and_ Python, so the Python gates cannot
  silently rot.
- A fresh clone needs no Python setup step: the venv bootstraps on first use.
- Contract drift between the two languages fails fast, in CI, with a readable diff.
- Turbo's per-package caching keeps a single work package's loop short.

**Costs and risks**

- `@montaj/config` is a hard dependency of everything; a bad change there breaks the
  whole repo at once. Mitigated by it being small, fully tested and rarely edited.
- The Node-to-Python bridge is one more moving part than calling `pytest` directly.
  Accepted because it is the only way `pnpm test` can be the single entry point on
  Windows and Linux alike.
- Pinning pnpm exactly means Corepack downloads it on first use in CI. Accepted for
  reproducibility.
- `noUncheckedIndexedAccess` costs some ceremony at array and record accesses. Kept:
  this codebase indexes into transcripts and word arrays constantly, and an
  off-by-one there is a user-visible caption bug.

## Alternatives considered

| Option                                                | Why not                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nx** instead of Turborepo                           | More capable, more configuration. `05-system-architecture.md` section 1 already chose Turborepo.                                                   |
| **npm or yarn workspaces**                            | pnpm's strict `node_modules` prevents phantom dependencies, which matters most when many agents add dependencies in parallel.                      |
| **ESM (`"type": "module"`) everywhere**               | NestJS and its ecosystem are CJS-first; mixing would cost interop shims in exchange for nothing A01 needs.                                         |
| **Jest for `apps/api`** (the NestJS default)          | CONTRACTS section 9 mandates Vitest. One runner, one config, one reporter.                                                                         |
| **Type-aware ESLint (`projectService`)**              | Several times slower and needs a build first; `tsc --noEmit` already covers it.                                                                    |
| **uv instead of pip-tools**                           | uv is excellent but not installed on the build host, and pip-tools needs only stdlib `venv` + pip. Revisit when uv is a hard dependency elsewhere. |
| **A separate CI job per package**                     | Slower and noisier than turbo's own graph and cache.                                                                                               |
| **Duplicating queue names and env vars per language** | The failure mode is a silently empty queue in production. The parsing tests cost ten lines.                                                        |

## Follow-ups

- **X05** takes the same environment schema into Terraform so staging cannot drift.
- **A03** replaces the guarded `db:migrate` no-op with real Prisma migrations.
- **A08** lifts the queue-name and job-envelope declarations out of the two workers
  into the shared jobs contract.
- Revisit ESM and `uv` at the next major dependency bump.
