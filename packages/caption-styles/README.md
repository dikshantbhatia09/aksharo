# @montaj/caption-styles

StyleDoc v2 schema, the 30+ system styles and CI-written parity flags.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A02 (schema), A16 (styles), A18a (parity flags).

A18a's parity gate writes `assRenderable`, `assExportable` and `requiresLayoutMetrics`
onto each style after comparing CanvasKit, Skia-Node and libass renders.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                           | What it does                                    |
| ------------------------------------------------ | ----------------------------------------------- |
| `pnpm --filter @montaj/caption-styles build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/caption-styles typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/caption-styles lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/caption-styles test`      | Vitest                                          |
