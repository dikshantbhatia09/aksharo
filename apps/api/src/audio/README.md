# `audio` — the audio-clean feature (B10)

The producer that starts an `ai.clean` run, the reads a project's clean
history needs, and what an `ai.clean` completion writes back.

Design references: `docs/CONTRACTS.md` §3 (queues, the completion callback),
§4 (`CreditsFacade`), §6 (storage keys); `03-architecture/09-ai-pipeline.md`
§Audio clean; `03-feature-spec.md` F-401; `12-redesign-decisions.md` D19.

## Shape

```
POST /projects/{id}/audio/clean {strength, target, dereverb?, deesser?}
  → quote (packages/config's audioClean burn rate) → hold → ai_cleans row
    (queued) → JobsService.enqueue("ai.clean")
worker completion (AudioCleanCompletionHandler, ai.clean only)
  → audio_cleans row: status succeeded, metrics, storageKeys
GET /projects/{id}/audio/cleans
  → newest first; a row still queued/running is reconciled against its job
    row first (AudioService.reconcile) because a failed or dead-lettered
    completion never reaches the handler (JobsService.runCompletionHandler
    only runs on success)
```

Unlike `transcripts`, the `audio_cleans` row **is** created at request time
rather than left to the completion — a clean run is additive (a project can
hold several: undo, A/B) so there is no "one live draft" for an orphaned row
to collide with, and the list endpoint needs something to show while a job is
still queued.

## The `SetAudio` / `cleanId` gap

The brief calls for `EdgOp SetAudio {cleanId|null, strength}`, but the frozen
schema (`packages/edg/src/schemas/ops.ts`, `document.ts`'s `AudioCleanSchema`)
carries `clean?: {enabled, preset?, targetLufs?}` — no `cleanId` field, and it
predates this work package. Rather than fork a frozen interface, B10 encodes
the id in `preset` by convention: `"b10:<cleanId>"`.
`exports.service.ts#resolveAudioClean` is the one place that parses it back
out, when it builds the render manifest's `audio.strategy`. Reported as a
conflict per the work-package brief's own rule; flagged for an ADR if a future
work package wants a first-class `cleanId` field on `SetAudio`.

## What is not here

Enqueuing the `SetAudio` op itself belongs to the editor's own `EdgOpQueue`
(`apps/web/lib/edg/queue.ts`) — the Audio panel
(`apps/web/components/editor/audio/AudioPanel.tsx`) builds the op payload and
hands it to a caller-supplied `onSetAudio`, but this work package's remaining
time did not reach wiring that callback into a mounted panel inside the
editor shell. See the final report for the full list of what is deferred.
