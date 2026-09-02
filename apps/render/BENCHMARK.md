# Render benchmark

What a cloud render costs, measured rather than estimated. `04-research/RR-04-rendering.md`
put the Skia-in-Node path at **60–120 vCPU-seconds per output minute** and flagged the
figure as an engineering estimate; this file replaces it with numbers, and they are worse.

Reproduce any row with:

```bash
pnpm --filter @montaj/render bench -- --seconds 30 --preset 1080p
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
watermark. Three runs per row; the median is quoted.

| Preset                 | Output | Wall clock |         Throughput | Frames rasterised | Cache | vCPU-s / output min |
| ---------------------- | -----: | ---------: | -----------------: | ----------------: | ----: | ------------------: |
| **540p** 540×960@30    |   30 s |     7.80 s | **3.85× realtime** |         294 / 900 | 67.3% |                 187 |
| **1080p** 1080×1920@30 |   30 s |    28.57 s | **1.05× realtime** |         294 / 900 | 67.3% |                 688 |
| **4K** 2160×3840@30    |   10 s |    33.06 s | **0.30× realtime** |          61 / 300 | 79.7% |               2,380 |

Throughput scales linearly with pixel count — 540p is 3.7× the speed of 1080p for a
quarter of the pixels, and 4K is 3.5× slower again — which says the pipeline is
pixel-bound end to end rather than bottlenecked on any one stage.

The 1080p row spreads: three runs gave 1.23×, 1.05× and 0.94×. A desktop with a
browser open is not an isolated measurement environment, which is another reason the
row that decides the cost model has to be re-taken on the target instance.

**The vCPU-second figure is an upper bound.** It counts _every_ core as busy for the
whole wall clock (`wall × cores × 60 / output`), and the render does not saturate them:
Skia runs on one thread while x264 uses many, so neither half has all twelve. It is
quoted this way because it is the only reading that cannot flatter the result, and
because `05 §12`'s row needs a ceiling more than it needs an average.

### Against the target

The A20 brief asks for **≥ 2× realtime at 1080p on 4 vCPU**. Measured: **1.05× on 12
threads** (median of three; 0.94–1.23×). The target is not met, and the reason is structural rather than a missing
tuning flag.

Splitting a 30-second 1080p render into its halves (measured separately, same machine):

| Stage                                                              | Wall clock |
| ------------------------------------------------------------------ | ---------: |
| Skia only — layout, outline, hash, rasterise, read back 900 frames |     13.9 s |
| ffmpeg only — decode, overlay a constant RGBA stream, x264, mux    |     11.7 s |
| ffmpeg with no overlay at all — decode and re-encode               |      6.9 s |

The two halves are each about half the wall clock, and they **do not overlap**.
Rasterising a frame is synchronous and blocks Node's only thread; the OS pipe holds
64 KB, which is a hundred and twenty-eighth of a 1080×1920 frame, so ffmpeg starves
while Skia draws and Skia idles while ffmpeg encodes. Perfect overlap would put this at
roughly 14 s — about **2.1× realtime**, i.e. the target — with no change to either half.

Two things were tried and one worked:

- **Bounding the layer surfaces** (landed). `group`, `shadow` and `blur` each need an
  offscreen surface, and allocating it at frame size made one shadow cost a full-frame
  allocation, composite and Gaussian: **60 ms** for a shadow around a caption covering a
  sixth of the frame. `packages/render-skia-node/src/bounds.ts` computes the device box
  the children actually touch, and the same shadow now costs about 6 ms. Whole-frame
  drawing went from ~55 ms to **7.5 ms**, the render from 0.69× to ~1.1× realtime, and
  the parity table did not move by a single digit.
- **Running ahead into the pipe buffer** (reverted). Queueing four finished frames so
  ffmpeg could drink while Skia drew made it _slower_ — 0.82× against 0.95× — because
  the batch hands back one reused buffer, so every queued frame needs an 8.3 MB copy and
  the memcpy costs more than the overlap buys.

**The fix is to move the rasteriser off the main thread**, so Skia and x264 genuinely run
at the same time. That is a `worker_threads` change inside `createFrameSource` — the
frame loop already has a single, narrow interface (`frame(index) → Uint8Array`) for
exactly that reason — and it is out of A20's scope. Recorded as an open question.

Per-render throughput is also not the only number that matters: three concurrent
30-second 1080p renders on this machine finished in 61.4 s, i.e. **1.46× realtime
aggregate**, so `RENDER_CONCURRENCY` buys some of the gap back on a wide machine but not
all of it — the halves contend for the same cores.

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
   then the cost model has a desktop's numbers in it.
2. **The same three rows after moving the rasteriser to a worker thread**, which the
   split above predicts is worth ~1.8× at 1080p.
3. **A real caption mix.** Every row here uses the sample project, whose styles are
   `punch-pop` and friends; `liquid-glass` (a backdrop blur every frame) and `neon-glow`
   (a shadow-only layer per word) will be slower, and nobody has measured by how much.
