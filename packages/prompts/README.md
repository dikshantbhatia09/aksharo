# @montaj/prompts

Versioned LLM prompts and their evals.

**Status:** skeleton (scaffolded by A01). **Implemented by:** B11 (prompts), D08 (eval harness).

Prompts are versioned artefacts: transcripts are passed as delimited data blocks and
outputs are Zod-validated, never executed (THREAT-MODEL T19).

## Layout

```
src/index.ts   public surface (placeholder today)
```

## Scripts

| Script                                    | What it does                                    |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/prompts build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/prompts typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/prompts lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/prompts test`      | Vitest                                          |
