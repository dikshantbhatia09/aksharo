# `memory` — learned spellings, glossary, timing nudge, style prefs (B09)

The write side of learned memory (F-204, D62): a consent-gated CRUD/import/clear
surface over `memory_entries`, and the three learning-hook routes other work
packages call into.

Design references: `docs/CONTRACTS.md` §8 (error codes); `03-architecture/03-feature-spec.md`
F-204; `06-data-model.md` (`memory_entries`); `07-api-and-contracts.md` (`/memory`);
`09-ai-pipeline.md` §3 (glossary boosting); `12-redesign-decisions.md` D62.

## Who owns what

A11 already built the **reading** half: `transcripts/postprocess/glossary.source.ts`'s
`MemoryGlossarySource` reads consent-filtered `memory_entries` rows into a
transcription's post-correction pass (and, via `transcripts/postprocess/glossary.ts`,
the phonetic/edit-distance matcher that applies them). This module owns
**writing** the rows that reader sees, never the matching.

## The consent gate

`MemoryService.requireConsent()` re-reads the caller's current `memory` consent
record on every mutating call — the same query shape `MemoryGlossarySource` uses
to decide what to read. There is no cached boolean to get stale: a consent
withdrawn a second ago is honoured on the very next write, and nothing is stored
without an active grant.

Withdrawal itself erases every entry for the user. `ConsentsService.set()`
(A05's file, `consents/consents.service.ts`) emits `consent.withdrawn`
(`consent-events.ts`) right after it stamps `withdrawnAt`, and
`MemoryService.onConsentWithdrawn` (an `@OnEvent` listener, global
`EventEmitter2`) deletes on it. This is a small, documented, additive edit
outside this work package's file boundary — see `consent-events.ts`'s docstring
for why, and the precedent it follows (`invoices/billing-events.ts`).

## Entry shape

`memory_entries.value` (JSONB) holds `{key, value, aliases?, source, deviceOnly,
hits}` — the same `{term|value, aliases}` shape `MemoryGlossarySource.parseTerm()`
already reads, so a glossary/spelling entry needs no translation to be consumed
there. `kind` is one of `spelling | glossary | timingNudge | stylePref`.

Every entry carries a 12-month rolling expiry (`expiresAt`), refreshed on every
write; `hits`/`lastUsedAt` are usage counters a future caller can bump through
`MemoryService.touch()`.

## Learning hooks

- `POST /memory/hooks/spelling-fix` — A15's "Fix spelling everywhere" records a
  `spelling` entry (wrong -> right, with the wrong spelling as an alias, script-aware).
  Called from the editor (`editor-client.tsx`'s `onFixSpellingEverywhere`) after
  the correction's own op batch has landed (`EditorStore.flush()`), consent-gated
  client-side the same way the timing nudge is (B09b).
- `POST /memory/hooks/timing-nudge` — one signed drag delta (ms); rolled into a
  per-workspace median caption offset (`medianOf`, up to the last 20 samples).
  A17's timing-nudge sink (`lib/timeline/nudge.ts`'s `TimingNudgeSink`) is
  implemented by `lib/timeline/memory-nudge-sink.ts`, debounced per drag and
  wired as `Timeline.tsx`'s effective default sink (B09b) — A02d's
  `SetWordTiming` feeds it exactly like a segment-edge drag does.
- `POST /memory/hooks/style-pref` — last style/template used per aspect ratio.

## Provider hints

`MemoryService.glossaryTermsFor(workspaceId, userId)` is the consent-gated read
(never throws on a missing grant — just returns nothing) that
`transcripts.service.ts`'s `buildHints()` merges into `params.hints` at enqueue,
request-time hints first, deduplicated, capped at `MAX_TRANSCRIBE_HINTS` (200,
B09b). `apps/worker-ai/worker_ai/hints/glossary.py`'s `prepare_hints()` — a pure
dedupe/trim/cap step, `MAX_HINTS_DEFAULT = 100` — runs inside
`processors/transcribe.py::_hints()` ahead of every provider's own vocabulary
shape (`word_boost`, `vocabulary`, `keyterms`, `initial_prompt`), so a
200-term API payload is never handed to a provider unshaped.
