# Render benchmark

What a cloud render costs, measured rather than estimated. `04-research/RR-04-rendering.md`
put the Skia-in-Node path at **60–120 vCPU-seconds per output minute** and flagged the
figure as an engineering estimate; this file replaces it with numbers, and they are worse.

Reproduce any row with:

```bash
pnpm --filter @montaj/render bench -- --seconds 30 --preset 1080p
pnpm --filter @montaj/render bench -- --seconds 30 --preset 1080p --workers 0   # inline
pnpm --filter @montaj/render bench -- --seconds 30 --preset 1080p --encoder h264_nvenc
pnpm --filter @montaj/render bench -- --seconds 10 --preset 4k --cpus 4
```

The benchmark renders the **same inputs the tests assert on** — `@montaj/edg`'s
`sample-project.json` captions over an ffmpeg `testsrc2` clip — through the same
`renderVideo` the worker calls, with a directory-backed store standing in for R2. A
number measured on different frames from the ones the tests pin is not a measurement of
anything.

## Machine

|                   |                                              |
| ----------------- | -------------------------------------------- |
| CPU               | Intel Core i5-12400F, 6 P-cores / 12 threads |
| RAM               | 16 GB                                        |
| OS                | Windows 11                                   |
| Node              | 24.19.0                                      |
| ffmpeg            | 9.0 (gyan.dev full build, libx264)           |
| `@napi-rs/canvas` | 1.0.8                                        |

**This is a developer desktop, not the target container.** `05 §12` prices the cloud
render on a **c7g.xlarge (4 vCPU Graviton3)**, which this machine is not; the
vCPU-second column below is the only figure that travels, and it is an upper bound (see
the caveat under it).

## Results

30 seconds of output, `libx264 veryfast`, captions from the sample project, no
watermark, the rasteriser on **four worker threads** (`min(cores − 1, 4)`). Three runs
per row; the median is quoted.

| Preset                 | Output | Wall clock |         Throughput | Frames rasterised | Cache | vCPU-s / output min |
| ---------------------- | -----: | ---------: | -----------------: | ----------------: | ----: | ------------------: |
| **540p** 540×960@30    |   30 s |     6.16 s | **4.87× realtime** |         294 / 900 | 67.3% |                 148 |
| **1080p** 1080×1920@30 |   30 s |    12.97 s | **2.31× realtime** |         294 / 900 | 67.3% |                 311 |
| **4K** 2160×3840@30    |   10 s |    22.19 s | **0.45× realtime** |          61 / 300 | 79.7% |               1,598 |

Throughput still scales with pixel count, which says the pipeline is pixel-bound end to
end rather than stuck on any one stage.

**The vCPU-second figure is an upper bound.** It counts _every_ core as busy for the
whole wall clock (`wall × cores × 60 / output`). With the pool that is much closer to
true than it was — four Skia threads plus x264 do use most of a twelve-thread machine —
but it is still a ceiling, and it is quoted that way because `05 §12`'s row needs a
ceiling more than it needs an average.

### Against the target: met

The brief asks for **≥ 2× realtime at 1080p**. Measured: **2.31×** (median of three;
2.31–2.34×), against **1.13×** for the same binary with `--workers 0`.

| 1080p, 30 s of output                     | Wall clock |     Throughput | vCPU-s / output min |
| ----------------------------------------- | ---------: | -------------: | ------------------: |
| A20 — rasterise inline (`--workers 0`)    |    26.48 s |         1.13×  |                 635 |
| A20b — 1 worker                           |    25.83 s |         1.16×  |                 620 |
| A20b — 2 workers                          |    18.23 s |         1.65×  |                 437 |
| **A20b — 4 workers (default)**            | **12.97 s** |    **2.31×**  |             **311** |

One worker is worth almost nothing (1.13× → 1.16×) and that is the tell: the win is not
"Skia got faster", it is "Skia stopped taking turns with ffmpeg". A single worker moves
the work off the main thread but still serialises it against the encoder's demand for
frames; the second and third are what actually fill the gaps.

### The stage split, before and after

Measured separately on the same machine, 30 seconds of 1080p output:

| Stage                                                                | A20 (inline) | A20b (4 workers) |
| -------------------------------------------------------------------- | -----------: | ---------------: |
| Skia — layout, hash, outline, rasterise, read back 900 frames        |      18.83 s |       **6.93 s** |
| ffmpeg — decode, overlay a constant RGBA stream, x264, mux           |      13.22 s |          13.22 s |
| ffmpeg with no overlay at all — decode and re-encode                 |       8.53 s |           8.53 s |
| **Whole render**                                                     |  **26.48 s** |     **12.97 s** |

Before, the two halves added up: 18.8 + 13.2 ≈ 32 s of work in a 26.5 s render, so they
barely overlapped at all. After, the whole render is 12.97 s against an ffmpeg half of
13.22 s — **the render now costs what the encoder costs**, and the rasteriser has
disappeared into it. That is the ceiling this architecture has: no amount of extra
parallelism goes below the x264 line without changing the encoder (the NVENC hook is
where that conversation starts).

### How it works, and what it cost

`src/render/pool.ts` runs `min(cores − 1, 4)` worker threads. One core is left for the
thread feeding ffmpeg; the ceiling of four is because the table above shows the encoder
taking over between two and four workers, and a fifth would only take a core x264 wanted.

Three decisions are load-bearing:

1. **Pixels never cross the thread boundary.** Each slot is a `SharedArrayBuffer` the
   main thread allocates once and every worker draws into. A20 already measured the
   alternative: an 8.3 MB copy per 1080p frame made the render *slower* (0.82× against
   0.95×) when it was tried as a pipe run-ahead buffer. What does cross is the finished
   `DrawCommand[]`, about 12 KB.
2. **The cache decision stays on the main thread.** Layout and `hashCommands` are ~0.9 ms
   a frame and they decide whether a frame is new; only the changed ones are dispatched,
   so two thirds of a render never reach a worker. Moving that into the pool would mean
   every worker knowing what the previous frame looked like.
3. **A slot is released only when the pipe says the bytes have gone.** `runEncode`'s
   `onFrameConsumed` fires from the `stream.write` completion callback, and the frame
   source reference-counts each slot — one reference for the cache's pin on the current
   frame and one for every output frame written from it. Getting that count wrong
   recycles a slot underneath a caption that is still on screen.

Memory is bounded by the slot count and nothing else: `slots × width × height × 4`, with
`slots = workers × 2`. Eight slots is **66 MB** at 1080p and **265 MB** at 4K, allocated
once, whatever the length of the video.

**Parity did not move.** The nineteen-frame table in
`packages/render-skia-node/README.md` is identical to four decimal places before and
after, and `src/render/pool.test.ts` renders every frame both ways and asserts the bytes
are equal — which is how a missing watermark was caught: the workers had their own Skia
and their own image table, and nothing had put the mark in it.

### The fallback

A machine without worker threads, an image missing `workers/raster-worker.mjs`, or
`RENDER_RASTER_WORKERS=0` all land on the inline rasteriser, with a warning. It is the
same code A20 shipped and it renders the same pixels, at A20's speed.

### Concurrency

Per-render throughput is not the only number: `RENDER_CONCURRENCY` runs several renders
in one pod. With the pool that is now a trade rather than a gain — four rasteriser
threads and x264 already use most of the machine — so a pod should raise concurrency
only when its renders are small (540p proxies) or its cores are many.

### What the frame cache is worth

The cache reuses the previous frame's pixels whenever the command list hashes the same
(`src/render/frames.ts`). On the sample project it removes **two thirds** of the
rasterisation work at 1080p and **four fifths** at 4K — captions animate for about three
hundred milliseconds and then hold still, and the gaps between them are identical empty
frames. Without it, the 1080p row would be roughly three times its rasterisation cost.

The cache is exact, not approximate: it keys on `hashCommands` of the list `renderFrame`
produced, and outlining is a pure function of that list, so two frames that hash the same
cannot draw differently.

## The ffmpeg command lines

The graph for the 1080p row, exactly as `buildFfmpegArgs` produced it:

```
ffmpeg -hide_banner -nostdin -loglevel error -y \
  -i source.mp4 \
  -f rawvideo -pixel_format rgba -video_size 1080x1920 -framerate 30 -i pipe:0 \
  -filter_complex "[0:v]setsar=1,fps=30[base];[base][1:v]overlay=x=0:y=0:eof_action=pass:format=auto[vout]" \
  -map "[vout]" -map 0:a \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 48000 \
  -r 30 -t 30.000 -movflags +faststart export.mp4
```

With an accepted cut, the base picks up a `trim`/`concat` pair per retained span:

```
  -filter_complex "\
    [0:v]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0]; \
    [0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0]; \
    [0:v]trim=start=3.000:end=10.000,setpts=PTS-STARTPTS[v1]; \
    [0:a]atrim=start=3.000:end=10.000,asetpts=PTS-STARTPTS[a1]; \
    [v0][a0][v1][a1]concat=n=2:v=1:a=1[cutv][cuta]; \
    [cutv]setsar=1,fps=30[base]; \
    [base][1:v]overlay=x=0:y=0:eof_action=pass:format=auto[vout]"
```

A source that is not already the output's aspect gains a `scale`/`crop` pair between the
concat and the `fps` — for a 1920×1080 source into a 1080×1920 Reel:

```
    [cutv]scale=3414:1920:flags=bicubic,crop=1080:1920:1167:0,setsar=1,fps=30[base]
```

## NVENC

`RENDER_VIDEO_ENCODER=h264_nvenc` swaps the encoder and nothing else: same filter graph,
same overlay frames, `-preset p4 -rc vbr -cq <crf> -b:v 0`. It is **not measured here** —
this machine has no NVIDIA card — and it is off by default. `RR-04 §P2.16` puts the
evaluation after cloud volume passes ~500 output-hours/month, and the split above says
why it would help less than it looks: x264 is a little under half the wall clock, so
removing it entirely caps the gain at about 2×.

## What to measure next

1. **The same three rows on a c7g.xlarge**, which is the instance `05 §12` prices. Until
   then the cost model has a desktop's numbers in it — and the pool's default size will
   be **3** there (`min(4 − 1, 4)`), not 4, which the table above suggests is worth
   about 2×.
2. **NVENC.** ffmpeg is now the whole render, so the encoder is the only line left to
   move. `RR-04 §P2.16` puts that after ~500 output-hours a month.
3. **A real caption mix.** Every row here uses the sample project, whose styles are
   `punch-pop` and friends; `liquid-glass` (a backdrop blur every frame) and `neon-glow`
   (a shadow-only layer per word) will be slower, and nobody has measured by how much.
