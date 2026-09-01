# @montaj/api-client

OpenAPI-generated API client and TanStack Query hooks.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A03 (spec), A13 (hooks).

Generated from the NestJS OpenAPI document served at `/docs-json`. Regenerate whenever
the spec changes; the contract test compares client and spec (10-build-plan §5).

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                       | What it does                                    |
| -------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/api-client build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/api-client typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/api-client lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/api-client test`      | Vitest                                          |
