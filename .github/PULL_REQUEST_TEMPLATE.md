# <WP id> — <title>

<!-- One PR per work package. Keep it small; see 10-build-plan.md section 2. -->

## What changed

<!-- Two or three sentences. Link the brief and the architecture sections you implemented. -->

- Work package: `<A01 | A02 | ...>` (see `docs/PLAN.md`)
- Architecture: `03-architecture/<file>.md` section `<n>`

## How to verify

```bash
pnpm install
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

<!-- Add the WP-specific commands and what a reviewer should see. -->

---

## Definition of Done (10-build-plan.md section 2)

- [ ] **CI green** — lint, typecheck, unit, contract and e2e smoke all pass.
- [ ] **`docker compose up` works from clean** — verified on a fresh volume (`down -v` first).
- [ ] **Acceptance criteria met** — from the brief and `03-feature-spec.md`.
- [ ] **Tests ship with the change** — unit, plus one integration or e2e where applicable.
- [ ] **Property tests present** if this WP touches **credits** or **EDG ops**
      (fast-check for TS, hypothesis for Python).
- [ ] **README section** added or updated for the package or app touched.
- [ ] **`CHANGELOG.md` entry** under `## [Unreleased]`.
- [ ] **ADR written** for any deviation from `03-architecture/` (`docs/adr/NNNN-*.md`).
- [ ] **No `TODO` without an issue link.**
- [ ] **Feature-flagged** if user-visible and unfinished.

## Contracts

- [ ] `docs/CONTRACTS.md` is **unchanged**, or this PR carries the approving ADR.
- [ ] Contracts changed **before** their consumers; `@montaj/api-client` regenerated
      and contract tests pass, if the OpenAPI document moved.
- [ ] No package's internals were modified to make this WP pass. (If that was
      needed, raise an issue or an ADR instead and let Fable re-plan.)

## Security and data (docs/THREAT-MODEL.md)

- [ ] Threat rows this WP owns are addressed: `<T1, T8, ...>` — or **n/a**.
- [ ] **No secrets in code, tests, fixtures or logs**; `.env.example` is current.
- [ ] Ownership and workspace guards on every new route; ids are ULIDs.
- [ ] Any user-supplied URL goes through the SSRF-guarded client (T6).

## Conventions

- [ ] TypeScript `strict`; Python `mypy --strict` and `ruff` clean.
- [ ] Brand strings come from `@montaj/config` — the codename `montaj` appears in
      no UI copy, domain, bundle id, plugin id, installer name or marketing string.
- [ ] IDs are ULIDs; times are `timestamptz` in the DB, ISO-8601 in JSON, `*Ms`
      for media time; money is integer minor units; credits are integer `*Tenths`.
- [ ] Conventional Commit title.

## Screenshots / evidence

<!-- UI work: before and after. Worker or API work: the relevant log lines or test output. -->

## Open questions for Fable

<!-- Anything you assumed, anything that should become an ADR. -->
