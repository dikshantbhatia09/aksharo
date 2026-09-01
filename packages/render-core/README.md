# @montaj/render-core

Backend-independent caption layout (HarfBuzz-wasm, bundled subset fonts) producing DrawCommand[].

**Status:** skeleton (scaffolded by A01). **Implemented by:** A16.

The single source of layout truth. Every backend (CanvasKit, Skia-Node, ASS) consumes
the same `DrawCommand[]`, which is what makes the parity gate meaningful.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                        | What it does                                    |
| --------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-core build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/render-core typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/render-core lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-core test`      | Vitest                                          |
