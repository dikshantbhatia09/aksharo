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

### Frame/RMS sampling and `passes/proxy_required` (B19b)

B19 sent `detections`/`sceneFrames`/`rmsSamples` empty because no frame decode was
wired anywhere; B19b wires it, but on the **worker** side, not here —
`startZoom`/`startReframe` still send those three empty on purpose, and an empty list
is the signal `worker_ai.processors.reframe_zoom_pass._payload_needs_sampling` reads
to sample the project's 540p proxy itself (`apps/worker-ai/worker_ai/passes/
README.md`'s "Frame and RMS sampling" section). What this producer does add is
`requireProxy`: `startZoom`/`startReframe` reject the request outright
(`passes/proxy_required`, 409) when the project's primary media has no proxy yet,
since the worker has nothing to sample without one. `emphasisWords` are read from the
live document's segments (`Segment.emphasis`, CONTRACTS §2), one cue per emphasised
_word_, timestamped by that word's own `s` (`emphasisCuesOf` resolves each `wordId`
against the transcript's current revision) — B19 approximated this as the segment's
`startMs`.

### `PassType` and the keyframe payload rule — closed by B19b

`passes-completion.handler.ts`'s class docstring covers both: `PassTypeSchema` gained
`"zoom"` (CONTRACTS §2, amended 2026-09-03), so a zoom pass now lands with its own
type rather than borrowing `"reframe"`; and the keyframe payload rule (same amendment)
is implemented — the worker decides inline (`payload.keyframes`, base64, <= 64 KiB) vs.
derived storage (`payload.keyframesRef`, uploaded by the worker itself) and mints the
item id the derived key needs, so this handler only decodes or passes the field
through, never uploading bytes itself.

## Algorithm (zoom/reframe)

`apps/worker-ai/worker_ai/passes/{scenes,tracking,zoom,reframe,frame_sampling}.py` own
scene detection, subject tracking, cue detection, proxy sampling and keyframe
generation; see `apps/worker-ai/worker_ai/passes/README.md` for the full algorithm
writeup, presets, and models used. `apps/worker-ai/worker_ai/processors/
reframe_zoom_pass.py` is the thin queue adapter, including the byte-for-byte
packed-keyframe encoder mirroring `@montaj/edg`'s `encodeKeyframes` (MKF2).
