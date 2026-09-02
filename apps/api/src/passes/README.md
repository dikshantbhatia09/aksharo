# `passes` — edit-pass producers (B18: autocut)

`POST /projects/{id}/passes/autocut` quotes `@montaj/config`'s `BURN_RATES.autocutPass`
(source minutes, flash tier), holds the credits and enqueues `ai.pass` with:

- every live word of the transcript's current revision (`TranscriptsRepository.allChunks`)
- the primary media's id (so the worker can run real VAD over `audio16k.wav`, the same
  `speech_regions()` helper `ai.align` uses)
- `guardedRanges`: millisecond ranges of every segment carrying `emphasis` or
  `textOverrides` (CONTRACTS §2) — the one protection guard `Segment` can express today
- `protectedRanges: []` always — see "CONTRACTS gap" below

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

## CONTRACTS gap: `EdgHot.protected[]`

The brief (B18 §2) names user-marked protected ranges via `EdgHot.protected[]`. That
field does not exist in `packages/edg`'s frozen `EdgHot` type. `PassesService` always
sends `protectedRanges: []`; a future ADR would add the field to `EdgHot`, an op to set
it, and wire it through here. Flagged for Fable rather than added unilaterally — CONTRACTS
is changed only via an approved ADR.

## Algorithm

`apps/worker-ai/worker_ai/passes/autocut.py` owns the actual detection (silence, pause,
filler, retake) and protection/merge/removal-cap logic; see its module docstring and
`apps/worker-ai/tests/test_autocut.py` for the parameters, metric thresholds and property
tests. This module only shapes the HTTP surface and the completion.

## B19: zoom and reframe

`POST /projects/{id}/passes/zoom` and `POST /projects/{id}/passes/reframe` follow the
same producer shape as autocut — quote (`quoteReframeZoom`, `@montaj/config`'s
`BURN_RATES.reframeZoomPass`, flash tier), mint a `passId`, enqueue `ai.pass` with
`passType: "zoom"|"reframe"`. `passes.quote.ts`'s module docstring notes the same kind
of number-to-reconcile B18 flagged: the brief's "3 credits per media minute" matches
`reframeZoomPass`'s _pro_ rate, not the flash rate this quotes against.

### Payload gaps (flagged, not silently worked around)

Real scene detection and subject tracking need decoded video frames
(`apps/worker-ai/worker_ai/passes/README.md`'s "Gap" section); no video-decode
dependency was added in this work package, so `startZoom`/`startReframe` send
`detections`/`sceneFrames`/`rmsSamples` empty. The worker still produces correct zoom
events from emphasis-word cues alone (subject centre falls back to the frame's
saliency centre, `(0.5, 0.5)`), but a reframe job fails non-retryably
(`worker/invalid_payload`) with no subject track — this is a real, working failure
mode, not a silent no-op, until a follow-up work package wires A07 frame extraction
into this producer. `emphasisWords` are read from the live document's segments
(`Segment.emphasis`, CONTRACTS §2), one cue per emphasised segment, timestamped at the
segment's own `startMs` (an approximation of the emphasised word's own timing — see
`startZoom`'s docstring).

### `PassType` and `keyframesRef` gaps

`passes-completion.handler.ts`'s class docstring covers both in full: `PassTypeSchema`
has no `"zoom"` value, so both pass kinds land as `type: "reframe"`; and neither the
inline-bytea nor the derived-storage write path for `keyframesRef` exists yet, so the
handler computes and sets the addendum's key shape (`passes/{passId}/{itemId}.kf`)
without yet writing any bytes there.

## Algorithm (zoom/reframe)

`apps/worker-ai/worker_ai/passes/{scenes,tracking,zoom,reframe}.py` own scene
detection, subject tracking, cue detection and keyframe generation; see
`apps/worker-ai/worker_ai/passes/README.md` for the full algorithm writeup, presets,
and models used. `apps/worker-ai/worker_ai/processors/reframe_zoom_pass.py` is the
thin queue adapter, including the byte-for-byte packed-keyframe encoder mirroring
`@montaj/edg`'s `packKeyframes`.
