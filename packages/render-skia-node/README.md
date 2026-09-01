# @montaj/render-skia-node

@napi-rs/canvas (Skia) backend for the cloud render service.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A20.

Executes the same `DrawCommand[]` as the browser backend and emits RGBA overlay frames
for the ffmpeg overlay + x264 encode step.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                             | What it does                                    |
| -------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-skia-node build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/render-skia-node typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/render-skia-node lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-skia-node test`      | Vitest                                          |
