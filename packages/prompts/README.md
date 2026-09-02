# @montaj/prompts

Versioned LLM prompts and their evals.

**Status:** skeleton (scaffolded by A01). **Implemented by:** B11 (prompts), D08 (eval harness).

Prompts are versioned artefacts: transcripts are passed as delimited data blocks and
outputs are Zod-validated, never executed (THREAT-MODEL T19).

## Layout

```
src/index.ts        public surface (placeholder today)
lexicons/fillers/    per-language filler-word lexicons for the autocut pass (B18)
```

## `lexicons/fillers/*.json` (B18)

One file per language (`en`, `hi`, `hinglish`, `ta`, `te`, `bn`, `mr`, `gu`, `kn`, `ml`,
`pa`, `ur`), read by `apps/worker-ai/worker_ai/passes/autocut.py::load_lexicon`. Shape:

```json
{
  "language": "en",
  "version": 1,
  "entries": [
    { "token": "um", "scripts": { "roman": "um" }, "contextRule": "always", "weight": 0.97 },
    {
      "token": "like",
      "scripts": { "roman": "like" },
      "contextRule": "isolated_only",
      "weight": 0.6
    }
  ]
}
```

- `contextRule: "always"` — proposed as a cut wherever it occurs ("um", "uh", "hmm", "अं").
- `contextRule: "isolated_only"` — proposed only when the word sits at a clause start or is
  flanked by a pause ≥ 120ms on either side ("matlab", "basically", "like", "toh", "haan");
  this is what keeps a "like" used mid-sentence, or a "toh" used as a connector, from being
  cut in continuous speech.
- `weight` seeds the item's confidence (0–1).
- `scripts` carries script variants (`roman`, `native`) the matcher also checks, case-folded.

`en`/`hi`/`hinglish` are curated to the depth the B18 brief asks for and unit-tested against
precision/recall fixtures (`apps/worker-ai/tests/test_autocut.py`). The other nine languages
ship a small, correctly-shaped seed set (a handful of entries each) rather than a
linguist-reviewed list — flagged in the B18 final report as follow-up work, not silently
treated as complete.

## Scripts

| Script                                    | What it does                                    |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/prompts build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/prompts typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/prompts lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/prompts test`      | Vitest                                          |
