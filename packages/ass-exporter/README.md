# @montaj/ass-exporter

ASS/SSA sidecar writer plus the parity test harness.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A18a.

Also owns the golden-image comparison used by the parity gate
(SSIM >= 0.99, <= 1% of pixels differing by more than 2/255).

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                         | What it does                                    |
| ---------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/ass-exporter build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/ass-exporter typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/ass-exporter lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/ass-exporter test`      | Vitest                                          |
