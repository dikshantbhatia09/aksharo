# @montaj/ui

Design tokens and shared React components (shadcn/ui based).

**Status:** skeleton (scaffolded by A01). **Implemented by:** A13.

Tokens follow `03-architecture/08-ux-design-system.md`.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                               | What it does                                    |
| ------------------------------------ | ----------------------------------------------- |
| `pnpm --filter @montaj/ui build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/ui typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/ui lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/ui test`      | Vitest                                          |
