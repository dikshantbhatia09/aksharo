# Serverless GPU — cost assumptions

Source of truth for the target numbers: `03-architecture/05-system-architecture.md`
section 12 and decision **D15**. Everything below is an _assumption to be
replaced by measurement_; the benchmark work packages own the real figures.

Exchange rate used throughout: **₹95 / USD** (the rate 05 section 12 uses).

## 1. What 05 section 12 fixes

| Path                                                  | Cost per media minute | Note                                           |
| ----------------------------------------------------- | --------------------- | ---------------------------------------------- |
| ElevenLabs Scribe v2 (word timestamps + diarisation)  | ₹0.35                 | primary for Hindi, Indian English, 12 Indic    |
| Sarvam Saaras v4 Batch + alignment                    | ₹0.50 + ₹0.03         | Hinglish / code-mix; 8 uncovered languages     |
| AssemblyAI Universal-2                                | ₹0.24                 | global fallback                                |
| **Serverless GPU (large-v3-turbo + align + diarise)** | **₹0.09 – ₹0.13**     | **global primary — this document**             |
| Reserved GPU                                          | —                     | only above roughly **150,000 media-min/month** |

Blended COGS at the planned mix is ₹0.60–0.70 per media minute; net revenue per
credit on the Creator plan is about ₹1.16. The GPU line is the one we control
directly, so it is the one worth modelling.

## 2. How ₹0.09–0.13 per media minute is reached

The assumption chain, stated so it can be falsified:

| Input                                  | Assumed value                           | Where it comes from                                     |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| GPU class                              | 24 GB Ada / Ampere (L4, A5000, A10)     | `runpod/endpoint.json` `gpuIds`                         |
| Serverless on-demand rate              | **USD 0.00044 / s** (≈ USD 1.58 / h)    | RunPod 24 GB serverless list price                      |
| Real-time factor, large-v3-turbo, fp16 | **~0.055**                              | ~18× faster than real time on one 24 GB card            |
| Alignment + diarisation overhead       | **+35 %** of the ASR pass               | wav2vec2 CTC forced alignment plus pyannote community-1 |
| Effective GPU seconds per media minute | 60 × 0.055 × 1.35 ≈ **4.5 s**           |                                                         |
| Cost per media minute                  | 4.5 × 0.00044 ≈ USD 0.00198 ≈ **₹0.19** | at 100 % utilisation of a billed second                 |

That lands **above** the 05 section 12 band, which is the honest reading: the
₹0.09–0.13 figure assumes **batched chunks** keeping the card busy across
requests, so per-request padding and boot amortise away. Two levers get there:

- **Concurrency.** Two VAD-aligned chunks in flight on one 24 GB card (the
  `allow_concurrent_inputs: 2` in the Modal file, `flashboot` plus request
  batching on RunPod) roughly halves the billed seconds per minute of media.
- **Chunk size.** ~10-minute chunks (05 section 5.1) amortise model warm-up over
  a long enough window that it stops mattering.

**Treat ₹0.19 as the pessimistic case and ₹0.09–0.13 as the target**, and put
the measured value here after the first benchmark. If the measured number stays
near ₹0.19, the vendor path (AssemblyAI at ₹0.24, Scribe at ₹0.35) is closer
than the architecture assumes and the routing weights should move.

## 3. The warm floor is the fixed cost

Decision D15 requires **one warm instance per region**. That is a subscription,
not a variable cost:

| Item                                           | Assumption           | Monthly         |
| ---------------------------------------------- | -------------------- | --------------- |
| 1 × 24 GB GPU, always on                       | USD 1.58 / h × 730 h | **≈ USD 1,150** |
| Same, at active-worker rate with idle discount | idle billed at ~25 % | **≈ USD 290**   |

RunPod bills an idle warm worker at a reduced rate; the second row is the number
to plan against, the first is the ceiling if the discount does not apply. At
₹95/USD that is **₹27,500 – ₹109,000 a month** before a single minute of media
is processed.

Consequences worth stating:

- The warm floor only pays for itself above roughly **2,500 media-minutes a
  month** (₹27,500 ÷ ₹11 saved per minute against the cold-start latency cost).
  Below that, `workersMin: 0` and a visible ETA is the cheaper, more honest
  configuration — which is why `values-staging.yaml` does not run a warm floor
  at all.
- One warm worker per region multiplies this. Launch runs **AP only**; EU and
  US in `runpod/endpoint.json` `locations` are for overflow, not for a warm
  floor each.

## 4. Cold start

| Stage                                    | Assumption |
| ---------------------------------------- | ---------- |
| Container pull, image cached (flashboot) | 5 – 10 s   |
| Model load into VRAM (3 GB of weights)   | 15 – 25 s  |
| First token                              | 25 – 40 s  |

This is why the weights are baked into the image (`runpod/Dockerfile`). Pulling
them from Hugging Face at boot would add 30–90 s and make the transcript p95
target in 05 section 5.1 unreachable from cold.

## 5. When reserved GPU wins

D15 puts the crossover at about **150,000 media-minutes a month**. Sanity check:

- Serverless at the target ₹0.11/min × 150,000 = **₹16,500/month** variable,
  plus the ₹27,500 warm floor ≈ **₹44,000**.
- One reserved L4 (g6.xlarge on-demand, ap-south-1, ≈ USD 0.98/h) ≈ USD 715 ≈
  **₹68,000/month**, and at RTF 0.055 with 35 % overhead it clears roughly
  **220,000 media-minutes/month** if kept saturated.

So reserved capacity is cheaper per minute _only when the card stays busy_.
The crossover in D15 is the right order of magnitude; the deciding input is
utilisation, not price. **Do not move to reserved GPU on price alone — move when
the measured duty cycle of the serverless fleet is consistently above ~60 %.**
The Terraform `eks` module already carries a GPU node group behind
`enable_gpu_node_group`, so the migration is a variable flip plus a taint
toleration, not a rebuild.

## 6. What is NOT on the GPU

Deliberately, to keep the expensive resource for the thing only it can do:

- VAD (Silero), scene detection, muxing, waveform and thumbnail generation →
  the CPU pool (`worker-media`, `worker-ai` in the chart).
- Cloud render → CPU (Skia + x264 at ₹0.05–0.07/min, 05 section 12). NVENC is
  evaluated only above ~500 output-hours a month.
- Vendor ASR calls → no GPU at all; the CPU worker calls the provider.

## 7. Cost controls that must exist before the warm floor is switched on

1. **Per-workspace enqueued-credit cap and max queue wait** (THREAT-MODEL T23,
   owned by A08). Without these, one user can convert the GPU ceiling into a
   bill.
2. **`workersMax`** in `runpod/endpoint.json`, currently 20.
3. **The COGS-per-credit panel** in `infra/observability/dashboards`, with the
   admin throttle above 2× revenue described in 05 section 11.
4. **Per-job cost tags** (`montaj.job.cost.minor`, see
   `infra/observability/METRICS.md`) so the number in this file can be replaced
   with a measurement rather than another estimate.
