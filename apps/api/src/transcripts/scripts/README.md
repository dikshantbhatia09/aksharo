# `transcripts/scripts` — scripts and translation (A22)

Roman ↔ native transliteration per word (`Word.scripts`), translation as
segment-level caption overrides (`Segment.textOverrides.translated`), and the
read that tells the editor which scripts a transcript actually has.

Design references: `docs/CONTRACTS.md` §2 (`Word.scripts`, `Segment.
textOverrides`, the `SetSegmentText` op), §3 (queues, the completion callback),
§4 (`CreditsFacade`); `03-architecture/09-ai-pipeline.md` §4;
`04-pricing-and-monetization.md` (translation burn rate, plan gating);
`apps/api/src/transcripts/README.md` (A11 — the sibling module this one reads
from: `TranscriptsRepository`, `transcript-export.ts`); `apps/api/src/edg/README.md`
(the op-batch write path translation reuses, and `MergePass` is worker-only for
the same reason this module's own write is a separate signed surface).

## Two operations, two write paths, on purpose

**Transliteration** writes **per word**: potentially thousands of
`word.scripts[roman|native]` values in one job. There is no `EdgOp` for that —
the frozen `EdgOp` union has `EditWord{wordId, text, script?}` for one word at a
time, and submitting a thousand of those per job would mean either a thousand
ops per transliteration or a new op CONTRACTS §2 does not have (raised, not
taken). So the worker writes directly through this module's own signed
surface, `POST /internal/transcripts/{id}/scripts`
(`scripts-internal.controller.ts` → `ScriptsService.applyWordScripts` →
`ScriptsRepository.applyWordScripts`), which patches only the
`transcript_chunks` rows a job actually touched — the same shape A12's
`EditWord` handling uses, just batched.

**Translation** writes **per segment**, at most a few hundred per job, and
CONTRACTS §2 already has the op for it: `SetSegmentText{segmentId, script,
text}`. So the worker submits a batch of those to the **existing**
`POST /internal/projects/{id}/edg/ops` (`edg-internal.controller.ts`, A12,
unchanged here) with `script: "translated"`. That gets translation the whole
op-log machinery for free — rebase, conflict, revision, realtime publish — and
is why a translation landing after a user edited the same segment's translated
text comes back as a 409 the job reports as failed, never a silent overwrite.

## The path

```
POST /projects/{id}/transcript/transliterate {script}
  ├─ transcript exists?                        → 404 transcript/not_found
  ├─ read every live word's (wid, t)              free — no credit hold
  └─ JobsService.enqueue("ai.transliterate")

worker: transliterate every word -> {wid, text}[]
  ├─ POST /internal/transcripts/{id}/scripts     merges word.scripts, bumps
  │                                               transcripts.currentRevision,
  │                                               mirrors into the EDG doc,
  │                                               logs transcript.scripts_updated
  └─ POST /internal/jobs/{id}/complete            TransliterateCompletionHandler:
                                                    settle 0, nothing left to do

POST /projects/{id}/transcript/translate {targets[]}
  ├─ plan gate                                  → 402 transcript/plan_required
  ├─ quote per target (0.5 credit / media minute / target, 04 §Credits)
  ├─ one segment source text per live segment     `segmentSourceTexts` (A11's
  │                                               transcript-export.ts)
  └─ one JobsService.enqueue("ai.translate") per target

worker: translate every segment -> SetSegmentText[] ops
  ├─ POST /internal/projects/{id}/edg/ops         the existing A12 surface
  └─ POST /internal/jobs/{id}/complete             TranslateCompletionHandler:
                                                     record the language tag on
                                                     EDG meta, log
                                                     transcript.translated,
                                                     settle the (deterministic)
                                                     hold

GET /projects/{id}/transcript/scripts
  └─ scans the transcript's words for roman/native/en, the EDG segments for a
     `translated` override, and the two job events above for provenance
```

## Why transliteration is free and translation is not

`04-pricing-and-monetization.md`'s burn-rate table has no row for
transliteration — it is bundled with the product, not metered — so
`ScriptsService.transliterate` holds **zero tenths**. `packages/config/src/
credits.ts` is outside this work package's file boundary and already has
exactly what translation needs: `BURN_RATES.translation` (0.5 credit / media
minute / target language, `minimumPlan: "starter"`). This module's own
`assertTranslationAllowed` adds the second half of the gate the burn rate alone
cannot express — English is Starter+, every other language needs Creator+ —
against `resolveWorkspacePlan` (`jobs/plan.ts`, the same lookup `CreditsFacade`
uses for admission).

## Never overwriting a user's edit

`09 §4`: "user edits live in `textOverrides[script]` and are never
overwritten." That rule is enforced at **read time**, not at write time:
`transcript-export.ts`'s `toCues`/`wordText` and the editor both prefer
`segment.textOverrides[script]` over anything computed from `word.scripts`
whenever one exists, so a transliteration job is free to always recompute
`word.scripts` — the moment a user has typed their own text for a script on a
segment, that override wins regardless of what the words underneath now say.
Translation's own regeneration hazard — replacing a translation the user has
since hand-edited — is a **product** confirmation (the web "Regenerate
translation" dialog), not a backend refusal: the backend's guarantee is a clean
409 on a genuine conflict, not a policy about who may ask to overwrite what.

## The `?script=` extension to `GET /projects/{id}/transcript` and export

Both existing surfaces (A11's, outside this module's own files but extended by
it — see the WP report's file-boundary note) gained an optional `script` query
parameter: `roman | native | en | translated`. On the manifest read it projects
each word's `t` onto `scripts[script]` (falling back to the word's own primary
text); on export it threads through to `transcript-export.ts`'s `toCues`, which
prefers a segment's own `textOverrides[script]` first. Omitted, both keep their
exact pre-A22 behaviour.

## Files

```
scripts.controller.ts            POST .../transliterate, POST .../translate, GET .../scripts
scripts-internal.controller.ts   the signed worker surface (word.scripts write)
scripts.service.ts               producers, plan gating, the availability read
scripts.repository.ts            word.scripts merge; the EDG meta mirrors
scripts.dto.ts                   request schemas + OpenAPI response classes
scripts.errors.ts                the domain's error codes and its bounds
transliterate.handler.ts         ai.transliterate completion (settle only)
translate.handler.ts             ai.translate completion (meta + provenance + settle)
```

## Testing

```sh
pnpm --filter @montaj/api test src/transcripts/scripts   # unit
pnpm --filter @montaj/api test test/transcripts           # e2e: needs Postgres + Redis
```
