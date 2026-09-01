# @montaj/timemap

Source-time to output-time mapping across accepted cuts and speed changes.

**Status:** skeleton (scaffolded by A01). **Implemented by:** A02c.

One bidirectional mapping used by the browser exporter, the cloud renderer and the
plugin apply paths, so a caption drawn at output time lands on the right source frame.

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                    | What it does                                    |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/timemap build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/timemap typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/timemap lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/timemap test`      | Vitest                                          |
