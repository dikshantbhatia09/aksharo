# @montaj/render-canvaskit

CanvasKit (Skia WASM, WebGL) backend for the browser and the desktop app.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A16.

Executes `DrawCommand[]` from `@montaj/render-core` onto a WebGL surface.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                             | What it does                                    |
| -------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-canvaskit build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/render-canvaskit typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/render-canvaskit lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-canvaskit test`      | Vitest                                          |
