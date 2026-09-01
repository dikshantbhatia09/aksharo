# infra/gpu — serverless GPU for ASR, alignment and diarisation

Decision **D15**: launch on per-second serverless GPU with a warm floor of one
instance per region, and move to reserved L4/L40S only above roughly 150,000
media-minutes a month. A single model server keeps Whisper large-v3-turbo, the
forced aligner and pyannote community-1 co-resident; VAD, scene detection and
muxing stay on the CPU pool in the Kubernetes cluster.

Nothing in this folder is applied by Terraform or by CI. Creating the endpoint
is a **[H]** step (see `../README.md`, "Bootstrap order").

## Layout

| Path                    | What it is                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `runpod/endpoint.json`  | The serverless endpoint definition: GPU class, regions, warm floor, autoscaling. Placeholders are `{{UPPER_SNAKE}}`. |
| `runpod/Dockerfile`     | The model-server image, with all weights baked in.                                                                   |
| `runpod/bake_models.py` | Build-time weight download. Fails the build on a missing weight.                                                     |
| `modal/app.py`          | The same endpoint on Modal, so the provider is a flag rather than a rewrite.                                         |
| `COST.md`               | Cost assumptions from `05 §12`, with the arithmetic shown so it can be falsified.                                    |

`GPU_PROVIDER` in CONTRACTS section 1 selects which one the AI worker calls:
`runpod`, `modal`, `replicate` or `none`.

## Why the weights are in the image

A cold start that pulls 3 GB from Hugging Face adds 30–90 seconds. The transcript
target in `05 §5.1` is p50 ≤ 60 s and p95 ≤ 120 s for a five-minute clip, so a
download-on-boot design misses the target from cold every time. Baked weights put
the cold start at 25–40 s, which the warm floor then hides for all but the first
request after a scale-to-zero.

`HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are set at run time on purpose: a
missing weight must fail the container on boot, not quietly reach out to the
internet from inside a GPU worker holding user media.

## Autoscaling

`scalerType: QUEUE_DELAY` with `scalerValue: 20` — add a worker when the oldest
queued request has waited 20 seconds. Queue delay maps onto the latency target
directly; request count would scale on arrival rate and miss a queue that is long
because each item is slow.

`workersMin: 1` is the D15 warm floor. `workersMax: 20` is a ceiling, not a
target: without it, and without the per-workspace enqueued-credit cap from
THREAT-MODEL T23, GPU autoscaling is unbounded spend. Read `COST.md §7` before
raising either number.

## Regions and residency

`locations: "AP,EU-RO-1,US-OR-1"`. AP is the only one that should serve Indian
media: `05 §9` pins raw media and the database to `ap-south-1`, and the EU/US
entries exist for overflow capacity only. The routing layer must not send Indian
workspaces outside AP while the transfer impact assessment in `05 §8` is
outstanding, and the sub-processor list must name whichever provider is live.

## Building and deploying [H]

```bash
# 1. Build the model-server image. HF_TOKEN is a BuildKit secret: the gated
#    pyannote weights need it at build time, and it must never reach a layer.
printf '%s' "$HF_TOKEN" > /tmp/hf_token
DOCKER_BUILDKIT=1 docker build \
  -f infra/gpu/runpod/Dockerfile \
  --secret id=hf_token,src=/tmp/hf_token \
  -t "$REGISTRY/montaj/gpu-model-server:$TAG" .
shred -u /tmp/hf_token

docker push "$REGISTRY/montaj/gpu-model-server:$TAG"

# 2. Substitute the placeholders and create the endpoint.
sed -e "s|{{ENVIRONMENT}}|staging|g" \
    -e "s|{{REGISTRY}}|$REGISTRY|g" \
    -e "s|{{IMAGE_TAG}}|$TAG|g" \
    infra/gpu/runpod/endpoint.json > /tmp/endpoint.json

# 3. Create it through the RunPod console or API, then put the endpoint id into
#    SSM alongside the other GPU settings.
```

The endpoint id and the RunPod API key are **[H]** items. The API key is a
credential: it belongs in SSM under `/montaj/{env}/`, never in this repository.

## Scaling and incident handling

`docs/runbooks/scale-gpu.md` covers raising the warm floor, raising the ceiling,
switching regions and failing over to the vendor ASR path when the GPU provider
is unavailable.
