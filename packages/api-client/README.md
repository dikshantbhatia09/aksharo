# @montaj/api-client

OpenAPI-generated API client and TanStack Query hooks.

**Status:** the spec and the operation index are generated; the fetch layer and the
TanStack Query hooks land in A13.

Generated from the NestJS OpenAPI document served at `/docs-json`. Run `pnpm gen:client`
from the repository root whenever the spec changes; the contract test in
`src/index.test.ts` asserts the operation index still covers the routes consumers call
(10-build-plan §5).

## Layout

```
openapi.json                 the whole OpenAPI document (generated)
src/generated/operations.ts  typed index of every operation (generated)
src/index.ts                 public surface
```

Nothing under `src/generated/` is hand-edited — `pnpm gen:client` overwrites it.

## Scripts

| Script                                       | What it does                                    |
| -------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/api-client build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/api-client typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/api-client lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/api-client test`      | Vitest                                          |
