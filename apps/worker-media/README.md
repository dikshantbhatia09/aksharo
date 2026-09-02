# `@montaj/worker-media`

Everything FFmpeg touches: probe, 16 kHz and 48 kHz audio, the 540p proxy,
waveforms and thumbnails. A Node BullMQ worker with ffmpeg as a child process.

Design references: `docs/CONTRACTS.md` §3 (queues, envelope, completion callback,
two-key rotation) and §6 (derived keys); `docs/THREAT-MODEL.md` T5, T7, T8, T21;
`03-architecture/05-system-architecture.md` §5.1; `09-ai-pipeline.md` §5.

## What it does

```
media.probe {mediaId, key}
  → ffprobe over a signed URL          duration · fps · dimensions · rotation
                                       · codec · channels · HDR
  → ffmpeg -vn -af ebur128,silencedetect   loudness · loudness range · true peak
                                           · silence ratio · silence spans
  → PATCH /internal/media/{id}         the columns the row has
  → POST  /internal/jobs/{id}/complete the full result
  → the API's completion handler enqueues media.proxy as a CHILD

media.proxy {mediaId, key, durationMs, hasVideo, hasAudio, width, height, hdr}
  → audio16k.wav   mono 16 kHz PCM s16le
  → audio48k.wav   mono 48 kHz PCM s16le
  → waveform.json  peaks at 100/s and RMS at 10/s, both 0–1
  → proxy540.mp4   H.264 main, short side 540, CRF 28, faststart, AAC 96 k
  → thumb-{0..9}.jpg  ten frames, 320 px wide
  → PATCH /internal/media/{id} { ...keys, status: "ready" }
```

## The two things that shape everything else

**The source is never downloaded.** ffprobe and ffmpeg read the raw object through
a presigned GET URL, so probing a 4K sixty-minute upload costs a couple of range
requests and nothing at all in memory, and a media node never holds a customer's
original on disk. The only files on disk are the **outputs**, because
`+faststart` rewrites the moov atom at the end of the encode and a WAV header has
to be patched with its final length — both need a seekable destination.
`withWorkspace` deletes the scratch directory in a `finally`, so a throw, a
timeout and a clean run all leave the same nothing behind.

**The worker never writes the database.** Every fact reaches `media_assets`
through `PATCH /internal/media/{id}`, whose allow-list is the API's
(`apps/api/src/internal/internal-media.controller.ts`): technical measurements and
derived keys, never `projectId`, `storageKey`, `bucket` or a retention column, and
every key must sit under the asset's own prefix. What a probe _means_ — the plan's
duration cap, whether a proxy should be built at all — is the API's completion
handler, `apps/api/src/media/probe.handler.ts`.

## FFmpeg command lines

| Output          | Command                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| probe           | `ffprobe -print_format json -show_format -show_streams -show_entries …stream_side_data=rotation… -i <src>`                                                                                        |
| loudness        | `ffmpeg -loglevel info -i <src> -map 0:a:0 -vn -af ebur128=peak=true,silencedetect=noise=-40dB:d=0.5 -f null -`                                                                                   |
| `audio16k.wav`  | `ffmpeg -i <src> -map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav out.wav`                                                                                                                    |
| `audio48k.wav`  | the same with `-ar 48000`                                                                                                                                                                         |
| `proxy540.mp4`  | `ffmpeg -progress pipe:2 -i <src> -map 0:v:0 -map 0:a:0 -vf <filter> -c:v libx264 -profile:v main -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k -ac 2 -movflags +faststart out.mp4` |
| `thumb-{n}.jpg` | `ffmpeg -ss <t> -i <src> -map 0:v:0 -frames:v 1 -vf scale=320:-2 -q:v 4 out.jpg`                                                                                                                  |

The proxy's video filter is `scale=W:H:flags=bicubic,format=yuv420p`, with the
tone-map chain in front of it when the source is PQ or HLG:

```
zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,
tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:range=tv
```

Four details in there are load-bearing rather than stylistic:

- **`W` and `H` are computed in TypeScript**, not with a `scale` expression. The
  rule is "shortest side to 540, both even, never upscaled" — this is a
  vertical-video product, and scaling a 1080×1920 phone clip to 540 _height_
  would make it 304 px wide. Nested `if(gt(iw,ih),…)` in a filtergraph needs its
  commas escaped through two parsers, and getting that wrong fails at runtime on
  exactly the aspect ratio nobody tested.
- **`-ss` goes before `-i`** for thumbnails. After it, ffmpeg decodes from the
  start of the file to the timestamp; before it, it jumps to the nearest keyframe
  and issues one range request. On a sixty-minute source that is ten seconds
  versus ten minutes.
- **`-map 0:a:0`**, not ffmpeg's own stream choice: a container with a commentary
  track would otherwise decide the transcript.
- **`profile:v main`**, not `baseline`: baseline has no CABAC, which costs about
  10% of the bitrate for compatibility with phones that stopped shipping in 2012.

If `zscale` is missing (an ffmpeg built without `libzimg`) the encode is retried
without the tone-map chain and a warning is logged. The proxy looks flat; the
alternative is an upload that cannot be edited at all.

## Derived outputs

| Object          | Format                                        | Why                                                    |
| --------------- | --------------------------------------------- | ------------------------------------------------------ |
| `audio16k.wav`  | mono, 16 kHz, PCM s16le                       | Whisper and every wav2vec aligner want exactly this.   |
| `audio48k.wav`  | mono, 48 kHz, PCM s16le                       | The mastering rate; `09 §5` cleans and re-times here.  |
| `proxy540.mp4`  | H.264 main, short side 540, CRF 28, AAC 96 k  | What the editor scrubs. A tenth of the bytes.          |
| `waveform.json` | peaks 100/s, RMS 10/s, both 0–1 of full scale | The timeline outline, and the "is anyone talking" bed. |
| `thumb-{n}.jpg` | 10 frames, 320 px wide, midpoints of tenths   | A filmstrip. `thumb-0.jpg` is the poster.              |

Keys are exactly `docs/CONTRACTS.md` §6 and are rebuilt from the envelope's ids
rather than from a path in the payload, so a job replayed from the dead-letter
queue months later still writes to the right place.

**There is no `poster.jpg`.** CONTRACTS §6 enumerates the derived set and does not
include one; `thumb-0.jpg` is the poster where a video has thumbnails, and an
audio-only upload has none — the studio draws the waveform in that space instead.

**Both envelopes are normalised against full scale, not against the file's own
maximum.** Two clips in one timeline have to be comparable, and a self-normalised
waveform draws a whisper and a shout identically. The peaks are computed from the
16 kHz WAV in 64 KiB chunks, so a sixty-minute file (115 MB of PCM) never lands in
memory.

## Audio-only and silent inputs

An audio-only upload gets its two WAVs and its waveform and skips the video half
entirely — no proxy, no thumbnails, and `ready` as soon as those three exist. A
silent video is the mirror image: a proxy and thumbnails, no audio artefacts and
no waveform. Cover art on an MP3 is **not** treated as a video stream, or a
podcast would get a proxy of its album art.

## Failure, retries and what the user is told

| Failure                     | Completion posted?           | Media row |
| --------------------------- | ---------------------------- | --------- |
| retryable, attempts remain  | no — BullMQ retries          | untouched |
| retryable, final attempt    | yes, `finalAttempt: true`    | `failed`  |
| non-retryable (any attempt) | yes, `error.retryable:false` | `failed`  |
| envelope does not parse     | no (there is no jobId)       | untouched |

A08 gives every `media.*` job three BullMQ attempts but the `jobs` row has a
single `attemptId`, so a failed completion posted on attempt one moves the row to
`failed` and attempt two's completion is rejected as `already_completed` — the
retry would be invisible to the product. Hence the first line of the table. For
the same reason the media row is only marked `failed` when the failure is
**terminal**: an asset shown as failed while two attempts remain is a lie the next
attempt has to undo, and the user has watched it happen.

The user sees a code from a closed set — `media/unsupported`, `media/corrupt`,
`media/no_streams`, `media/too_long`, `media/probe_failed` — because
`failure_reason` is rendered in the studio and an open string would be a
worker-controlled sentence on somebody's screen. The **operator** sees the last
twelve lines of ffmpeg's stderr on `jobs.error`, with every URL query string
redacted: the source is a presigned URL, ffmpeg prints the URL it could not open,
and without `redact()` a job's error column would hold a working read capability
for a customer's footage (THREAT-MODEL T21).

## Locks, heartbeats and shutdown

`media.probe` and `media.proxy` both take a **ten-minute lock** with the stall
check every minute (`QUEUE_POLICY_OVERRIDES` in
`apps/api/src/jobs/jobs.config.ts`; `src/policies.ts` is this worker's copy and
`policies.test.ts` parses the API's source to prove they have not drifted). The
family default of two minutes was sized for "ffprobe a short clip"; a two-minute
lock on a 4K sixty-minute proxy means the job is declared stalled and handed to a
second worker **while the first is still encoding it**, which is two ffmpeg
processes writing the same derived keys.

The lock is renewed at a third of its duration, and the same cadence drives the
progress callback — `JobsService.recordProgress` promotes a `queued` job to
`running`, so one call is both the heartbeat and the percentage the browser sees.
A long encode reports a real figure because `-progress pipe:2` gives ffmpeg's
`out_time_us`, not a guess.

`SIGTERM` aborts the shared `AbortController` first (killing every ffmpeg child)
and then closes the workers, so a rolling deploy does not wait forty minutes for
an encode. A killed encode is a retryable failure and the next pod picks it up.

## Prerequisites

**FFmpeg 6 or newer**, on `PATH` or at `FFMPEG_PATH`/`FFPROBE_PATH`. The worker
checks both binaries and their major version **before** it connects to Redis and
refuses to start otherwise: a worker that silently produces flat HDR proxies and
reports no progress is worse than one that will not start.

```
Windows  winget install Gyan.FFmpeg
macOS    brew install ffmpeg
Debian   sudo apt-get install -y ffmpeg
```

Six is the floor because the proxy chain needs `zscale`/`tonemap`,
`-progress pipe:2` and `-reconnect_on_network_error`. Development and CI run 9.x;
`Dockerfile` installs Debian's, which is 7.x on trixie.

## Run

```bash
docker compose up -d                          # redis + minio from the repo root
pnpm --filter @montaj/worker-media dev        # tsx watch
pnpm --filter @montaj/worker-media start      # built output
```

| Variable                         | Default            | What                                                |
| -------------------------------- | ------------------ | --------------------------------------------------- |
| `WORKER_MEDIA_CONCURRENCY`       | `2`                | Parallel jobs per queue.                            |
| `WORKER_MEDIA_QUEUES`            | both               | Pin a pod to `media.probe` or `media.proxy`.        |
| `MONTAJ_QUEUE_PREFIX`            | `bull`             | Must match the API's, or they talk past each other. |
| `FFMPEG_PATH` / `FFPROBE_PATH`   | `ffmpeg`/`ffprobe` | A build that is not on `PATH`.                      |
| `WORKER_MEDIA_TEMP_DIR`          | OS temp            | Where scratch files go.                             |
| `WORKER_MEDIA_SOURCE_URL_TTL`    | `21600`            | Signed source URL lifetime, seconds.                |
| `WORKER_MEDIA_FFMPEG_TIMEOUT_MS` | `2700000`          | Ceiling on one ffmpeg run.                          |
| `WORKER_MEDIA_LOUDNESS`          | on                 | `0` skips the EBU R128 pass.                        |

Everything else comes from the validated `Env` of CONTRACTS §1. No value from
either source is ever logged (THREAT-MODEL T21).

## Tests

```bash
pnpm --filter @montaj/worker-media test            # unit + processors
pnpm --filter @montaj/api test:e2e                 # the whole pipeline
```

`src/processors/processors.test.ts` runs both processors against **real ffmpeg**
with the object store faked — no Redis, no database, no network — so a bad
filtergraph fails in three seconds. `apps/api/test/media-pipeline.e2e-spec.ts` is
the other half: it uploads a synthetic ten-second clip through A06's presigned
flow to MinIO, **spawns this worker as a process** against the shared Redis, and
asserts every CONTRACTS §6 object exists, that `media_assets` was updated through
the allow-listed patch, and that `media.proxy` ran as a child of the probe. Both
are needed: the fake cannot catch a wrong BullMQ prefix or a signature over a
re-encoded body, and the e2e is too slow to be the only feedback on a filtergraph.

Fixtures are generated with ffmpeg's own `testsrc` and `sine` at test time rather
than committed: a binary in the repository is a binary nobody can review.
