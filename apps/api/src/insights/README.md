# Insights (B11)

`POST /projects/{id}/insights` and `GET /projects/{id}/insights`: chapters,
summary and hooks/titles/hashtags generated from a project's transcript
(F-206/F-207). The templates and their schemas live in `@montaj/prompts`; the
actual LLM call happens in `apps/worker-ai/worker_ai/llm/` (`ai.llm` queue).

## Flow

```
POST /projects/{id}/insights {kinds, tone?, regenerate?}
  → InsightsService.request
      project + workspace region                 (404 across tenants, T4/T5)
      TranscriptsService.chunks() (paged)          → PromptTranscriptInput
      per kind: quoteInsight(kind) → JobsService.enqueue("ai.llm", ...)
  ← {jobs: [{kind, jobId, deduplicated, tenths}], totalTenths}

ai.llm completes → InsightsCompletionHandler
  parses {templateId, version, provider, region, output, usage, providerSubmissions}
  → llm_outputs row + provider_submissions rows
  → actualTenths (flat per kind, never more than the hold)

GET /projects/{id}/insights → latest llm_outputs row per kind + the disclosure line
```

## Credits

`insights.quote.ts` prices per kind (brief §4): chapters 2 credits, summary 1
credit, hooks 2 credits, flat per run.

**Known conflict with `packages/config`.** `BURN_RATES.chaptersSummaryHook`
already exists there as a single flat "2 credits per job" rate for all three
kinds — which disagrees with this brief's per-kind pricing (summary is 1, not
2). `packages/config` is outside this work package's file boundary
(`packages/prompts/**`, `apps/worker-ai/worker_ai/llm/**`,
`apps/api/src/insights/**`, `apps/api/prisma/**`), so the per-kind prices are
implemented locally in `insights.quote.ts` rather than edited into the shared
table. Flagged for Fable to reconcile — either retire `chaptersSummaryHook` in
favour of three per-kind rates, or fold summary into the same flat rate and
update this brief.

## PII minimisation

The `ai.llm` job payload built in `InsightsService.buildTranscriptInput` is
exactly `{language, mediaTitle, durationMs, segments[{startMs, endMs, text,
speaker}]}` — transcript text, the project's own title, and the diarisation
speaker label (`"spk0"`, not an identity). No user id, email, name or
workspace id crosses into the payload the worker/provider sees.

## Region pinning

The workspace's `region` (`in`/`eu`/`us`) travels in the job payload;
`worker_ai/llm/region.py::select_region_compliant_provider` refuses to call a
provider that does not declare that region in `supported_regions`, and fails
closed (`RegionBlockedError`, non-retryable `worker/region_not_supported`) for
an unrecognised region or one no configured provider serves. An EU workspace
therefore never reaches a non-EU endpoint — see
`apps/worker-ai/tests/test_llm.py::test_eu_workspace_never_selects_a_non_eu_provider`.

## Eval report format

`pnpm --filter @montaj/prompts eval` writes `packages/prompts/eval-results/`:

- `report.json` — `{generatedAt, provider, cases: [{fixtureId, kind,
templateVersion, checks: [{name, ok, detail}], ok}], totalCases,
failedCases, ok}`.
- `report.md` — the same, as a table (fixture × kind × template × pass/fail ×
  failing checks).

The `pnpm --filter @montaj/prompts eval` runner always exercises the
transcript-grounded fake generator (`src/eval/mock-provider.ts`) — no network,
no key, safe for CI (brief §6). To check a real provider manually, set
`LLM_PROVIDER=anthropic` (or `openai`) and the matching API key in
`apps/worker-ai`'s `.env` and exercise `POST /projects/{id}/insights` end to
end against a real project; there is no automated "real key" mode for this
runner today (documented gap, brief §6's second half — "with real keys
manually" is a manual verification step, not a CLI flag).
