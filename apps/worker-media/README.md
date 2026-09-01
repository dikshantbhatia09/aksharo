# @montaj/worker-media

Node BullMQ worker for everything FFmpeg touches: probe, 16 kHz and 48 kHz audio
extraction, 540p proxies to R2, waveforms, thumbnails and subtitle sidecars.

**Status:** A01 scaffold — consumes `media.probe` and completes with a stub result.
The real processors land in **A07**.

## Prerequisites

`ffmpeg` and `ffprobe` must be on `PATH`. The worker checks both **before** it
connects to Redis and refuses to start otherwise, with install instructions — a
worker without FFmpeg would claim jobs it cannot finish.

```
Windows  winget install Gyan.FFmpeg
macOS    brew install ffmpeg
Debian   sudo apt-get install -y ffmpeg
```

## Run

```bash
docker compose up -d                          # Redis from the repo root
pnpm --filter @montaj/worker-media dev        # tsx watch
pnpm --filter @montaj/worker-media start      # built output
```

On a healthy boot it logs one JSON line per required tool and then:

```json
{
  "level": "info",
  "service": "worker-media",
  "msg": "worker-media ready — waiting for jobs on media.probe"
}
```

`WORKER_MEDIA_CONCURRENCY` (default 2) caps parallel jobs.

## Contracts

`src/queues.ts` holds the frozen queue names and the job envelope from
`docs/CONTRACTS.md` section 3. Every job's `data` is validated with `isJobEnvelope`
before processing; a malformed job is a producer bug and fails immediately rather
than retrying. A08 moves these declarations into the shared jobs contract.

Storage keys follow CONTRACTS section 6: raw media in S3 under
`ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}`, derived objects in R2.

## Adding a processor (A07)

1. `src/processors/<queue>.ts` exporting `async function process<Name>(job: Job)`.
2. Register a `Worker` for its queue in `src/index.ts`.
3. Report progress with `job.updateProgress` — it is relayed to the browser as
   `job.progress` (CONTRACTS section 7).
4. Return the result; the API settles credits from the completion callback
   (CONTRACTS sections 3 and 4).
