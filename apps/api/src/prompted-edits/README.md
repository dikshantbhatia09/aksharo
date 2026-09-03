# `prompted-edits` — plan then run (D07)

`POST /projects/{id}/prompted-edits` calls the `edit-plan@1` planner
(`@montaj/prompts`) with the project's own facts — duration, language,
existing styles, the workspace's plan tier — and the creator's free-text
prompt. The planner's output is re-checked against `validateEditPlan`
(schema validity alone is not enough: a schema-valid plan can still exceed
the plan tier's pass-count budget, request the `pro` engine tier on a plan
that doesn't allow it, or name a style the project doesn't have) and stored
as a `prompted_edit_plans` row, `status: "planned"`. Nothing runs yet — the
plan preview sheet (`apps/web`'s `PromptedEditBox`) shows passes, rationale,
style/script and a credits estimate before the creator confirms.

`GET /projects/{id}/prompted-edits/{planId}` reads a plan back.

`POST /projects/{id}/prompted-edits/{planId}/run` quotes the plan
(`quotePromptedEdit`, `@montaj/config`'s `promptedEdit` burn rate — **held**
on the _source_ media duration, **settled** on the _finished_ (post-cut)
duration once the whole chain lands) and starts the first pass of the plan's
dependency-ordered chain (`autocut` → `zoom`/`reframe` → `sfx`/`music` →
`textfx`, `PROMPTED_EDIT_CHAIN_ORDER`). The rest of the chain is driven by
`../passes/prompted-chain.ts`'s `PromptedChainAdvancer`, not by this module —
see that file's own doc comment for why (the `ai.pass` queue has exactly one
registered completion handler, `PassCompletionHandler`, and this module
cannot register a second one).

## The planner client seam

`PlannerClient` (`planner-client.ts`) is a small port, not a queue round trip
through `apps/worker-ai` the way `chapters`/`summary`/`hooks` (B11) call an
LLM: `InsightsCompletionHandler` already owns the `ai.llm` queue exclusively,
and this work package's file boundaries do not include
`apps/api/src/insights/**`, so a second `ai.llm`-consuming template could not
be wired in without editing that module. `PromptedEditsModule` binds
`MockPlannerClient` (the deterministic seam `@montaj/prompts`' eval runner
also uses — the fixture/mock LLM this whole feature is proven through on a
machine with no LLM keys) unless `ANTHROPIC_API_KEY` is set, in which case it
binds `AnthropicPlannerClient` — a real Anthropic Messages API call, type-
checked here but never exercised by a test or bound on this build machine.
Flagged as a deviation from the ai.llm-queue precedent, not a silent choice.

## Credits: one macro hold for the whole plan

`CreditHold.jobId` (`schema.prisma`) is a real, unique foreign key into
`jobs`, and `CreditsFacade.reserve` refuses to be called twice for the same
job. So `run()` never reserves separately: it folds the plan's whole
`holdTenths` into the chain's _first_ job's own `worstCaseTenths` via
`PassesService`'s additive `costOverrideTenths` request field, then reads
that job's minted `creditHoldId` back off the `jobs` row. Every later chain
step (`PromptedChainAdvancer`) starts with `skipCredits: true` — 0 cost of
its own, already covered by the first job's hold — until the last step
completes, at which point `PromptedChainAdvancer.settle` calls
`CreditsFacade.settle` once, on the finished duration.

## What is not wired here

- A rejected/failed chain step releases the hold and marks the plan
  `"failed"` (`PromptedChainAdvancer.onPassFailed`, called from
  `PassCompletionHandler.handleFailure`), but nothing re-offers the creator
  a retry from a partially-run plan — a fresh `POST /prompted-edits` starts
  over.
- A pass that is already in flight for the project (a manual run from the
  Passes tab, or a second prompted-edit plan sharing a pass kind) dedupes
  against the chain's own `jobKey` the same way any two manual pass requests
  do (`PassesService`'s existing per-kind `jobKey`); a chain step that lands
  on an existing job whose hold was already taken by that other caller is an
  edge case this work package did not add a test for.
