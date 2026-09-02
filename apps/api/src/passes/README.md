# `passes` — edit-pass producers (B18: autocut)

`POST /projects/{id}/passes/autocut` quotes `@montaj/config`'s `BURN_RATES.autocutPass`
(source minutes, flash tier), holds the credits and enqueues `ai.pass` with:

- every live word of the transcript's current revision (`TranscriptsRepository.allChunks`)
- the primary media's id (so the worker can run real VAD over `audio16k.wav`, the same
  `speech_regions()` helper `ai.align` uses)
- `guardedRanges`: millisecond ranges of every segment carrying `emphasis` or
  `textOverrides` (CONTRACTS §2) — the one protection guard `Segment` can express today
- `protectedRanges`: the user-marked `EdgHot.protected[]` set (`SetProtectedRanges`,
  CONTRACTS §2, B18b) concatenated with `guardedRanges` — every `ai.pass` is refused an
  item inside either half

`GET /projects/{id}/passes` is a thin read over `EdgService.passes` (A12); it exists at
this path because the B18 brief names it directly, not because the read is implemented
twice — `GET /projects/{id}/edg/passes` serves the same data.

## What an `ai.pass` completion does

`PassCompletionHandler` (registered on `JobCompletionRegistry`, same pattern as A11's
`TranscribeCompletionHandler`) turns the worker's `result.items` into a `MergePass` op —
the one write path `MergePass` has (CONTRACTS §2) — landed through
`EdgService.applyWorkerOps` in-process. `MergePass` is idempotent per `passId`
(`packages/edg/src/ops/apply.ts`), so a replayed completion callback is a no-op.

The worker attaches `wordIds` to each proposed item for audit/bookkeeping; this handler
reads them for the job event and drops them before persisting — `CutPayloadSchema` is
frozen empty (CONTRACTS §2), so a cut item's payload is always `{}` on the wire.

## Algorithm

`apps/worker-ai/worker_ai/passes/autocut.py` owns the actual detection (silence, pause,
filler, retake) and protection/merge/removal-cap logic; see its module docstring and
`apps/worker-ai/tests/test_autocut.py` for the parameters, metric thresholds and property
tests. This module only shapes the HTTP surface and the completion.
