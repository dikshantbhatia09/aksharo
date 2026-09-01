# @montaj/edg

EDG v2 types, Zod schemas, the EdgOp union, rebase transforms and migrations.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A02 (types + schemas), A02b (ops engine).

Frozen shape lives in `docs/CONTRACTS.md` §2. Nothing outside this package may redefine
`Word`, `Segment`, `PassItem` or `EdgHot`.

- A02 adds the Zod schemas, the `EdgOp` union and JSON fixtures.
- A02b adds the rebase transform table, CAS persistence, snapshots and `schemaVersion`
  migrations, with fast-check property tests (CONTRACTS §9).

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                | What it does                                    |
| ------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/edg build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/edg typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/edg lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/edg test`      | Vitest                                          |
