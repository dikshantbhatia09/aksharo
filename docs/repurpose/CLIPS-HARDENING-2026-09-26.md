# Clips pipeline hardening — 2026-09-26

Why: a pasted 18-minute YouTube link failed with "We could not get that video".
The root cause was format selection (4K AV1, 556 MB, over the Free plan's
500 MB cap, when 1080p H.264 is 187 MB), but a read-only audit of the whole
pipeline (9 auditors, every finding checked by independent skeptics; 63
confirmed, 0 refuted) found the pipeline had no way to *recover* from anything:

- failures were flattened to one code at three layers, so the user never
  learned the real reason or the right next step;
- `retryable: false` never reached BullMQ, so permanent failures ran 3 times;
- "Try again" reset the row and re-enqueued nothing;
- the only watchdog is scheduler-driven and production runs with
  `MONTAJ_SCHEDULER_DISABLED=1`; enqueues after transcription were
  fire-and-forget on an in-memory event, so a refused or lost enqueue left a
  run spinning forever (one has since 2026-09-15);
- one failed clip failed the whole run and hid every finished clip;
- a clip created while the plan lane was full was never cut, and could not be;
- the 9:16 crop is always the frame centre, so off-centre speakers are cut out
  before face-aware captions even start;
- highlight "discovery" returned the first N sentences of the video.

## Architecture

### 1. Durable state is the truth; the run is reconciled from it

`RepurposeReconciler.reconcile(run)` (apps/api/src/repurpose/reconciler.ts)
looks at durable state — the source media row, its jobs, the transcript, the
highlights job, candidates, clip rows and their jobs — and moves the run to
where that state says it is:

| Durable state | Reconciler action |
|---|---|
| acquire job failed (terminal) | run `failed`, code from the failure mapping (§2) |
| acquire job missing, media `pending`, run not cancelled | re-enqueue acquire |
| media `failed` after download (probe/proxy/duration cap) | run `failed`: `source_too_long` / `processing_failed` |
| media ready, no transcript, transcribe job failed | run `failed`: `transcription_failed` |
| media ready, no transcript, no transcribe job | start transcription (AutoTranscribeTrigger); refused for credits → `no_credits` |
| transcript exists, no highlights job, run not past analysis | start highlight discovery |
| highlights job failed | run `failed`: `highlights_failed` |
| highlights done, 0 candidates | run `candidates_ready` with 0 candidates (the page offers "add a moment by time") |
| clip row with no job (refused at admission) | enqueue it again (quietly waits while the lane is full) |

It runs on every `GET` of a run and of the run list (throttled per run), and at
the end of every completion handler. It is idempotent: every enqueue goes
through the existing jobKey dedupe. No scheduler is needed.

### 2. One failure vocabulary, end to end

worker (`media_assets.failure_reason`, closed set in both `errors.ts` and
`media.constants.ts`) → API mapping → run `failure_code` (closed set,
`SAFE_ERROR_CODES` in `@montaj/repurpose-contracts`) → web copy (`copy.ts`,
one title + reassurance + action per code).

| media reason | run code | web action |
|---|---|---|
| `media/too_large` | `repurpose/source_too_large` | choose another / upgrade |
| `media/too_long` | `repurpose/source_too_long` | choose another / upgrade |
| `media/source_private` | `repurpose/source_private` | choose another |
| `media/source_age_restricted` | `repurpose/source_age_restricted` | choose another |
| `media/source_live` | `repurpose/source_live` | choose another (after it ends) |
| `media/source_removed` | `repurpose/source_removed` | choose another |
| `media/source_blocked` | `repurpose/source_blocked` | **retry (same link) in a few minutes** |
| `media/source_playlist` | `repurpose/source_playlist` | check the link |
| `media/source_failed`, anything else from acquire | `repurpose/source_unavailable` | retry |
| probe/proxy failure (`media/unsupported`, `corrupt`, `no_streams`, `probe_failed`) | `repurpose/processing_failed` | retry / choose another |

A worker failure that is not retryable is thrown as BullMQ's
`UnrecoverableError` (both runtimes), so it runs once.

### 3. Retry means "run the failed stage again"

`POST /repurpose/runs/{id}/retry` re-enqueues the stage that failed (acquire
with a fresh jobKey suffix, transcription, highlight discovery), resets the
code, and lets the reconciler carry on. A clip retries on its own:
`POST /repurpose/runs/{id}/clips/{clipId}/retry`.

### 4. Clips are isolated

A clip's failure is the clip's, never the run's. Clip state is derived from
its row and its latest `media.clip` job: `ready` (mezzanine), `cutting` (job
live), `waiting` (no job yet — lane full; the reconciler enqueues it),
`failed` (latest job failed; retry offered). The run page always shows
candidates and clips, whatever else happened.

### 5. Framing follows the face

At `createClip` the API reads the source's `faces.json` (`ai.faces`), takes
the faces seen during the clip's interval, picks the dominant face track
(largest, most frequent), and sends its median horizontal centre as
`reframe.centerX` in the `media.clip` payload (contract `media.clip@1`,
optional field). The worker crops the 9:16 window around it, clamped to the
frame, at `profile.maxHeight` (1920 → a 1080 × 1920 mezzanine). No faces →
`basis: "centre"`. The clip project then gets its own `ai.faces` track on the
cropped picture (a re-cut clears the old one), so captions avoid the face in
the editor, every export, the share page and the run page's preview, which
now renders through the same `CaptionStage` rather than a WebVTT track.

`ai.faces` is background work: it no longer counts against the plan's
concurrency lane.

### 6. Acquisition picks what it can afford

`chooseFormat` (apps/worker-media/src/yt-dlp.ts) picks concrete streams from
the probe's own format list: tallest ≤ 1080p that fits 90 % of the byte cap,
H.264 over VP9 over AV1, HTTPS over HLS, original audio; down to 360p before
refusing. The download fetches exactly those ids.

### 7. Highlights look at the whole video

Sentence windows over the entire transcript (Devanagari `।` is a sentence
end; overlong sentences are split, not dropped), scored on content signals,
spread across the video, non-overlapping; titles keep the script intact. A
failed words fetch fails the job (retryable) instead of inventing a
candidate.
