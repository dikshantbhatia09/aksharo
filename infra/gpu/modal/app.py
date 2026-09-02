"""Modal equivalent of the RunPod endpoint (decision D15 says "RunPod/Modal class").

Kept deliberately small: it exists so that a RunPod outage, a price move or a
capacity squeeze in the AP region is a `GPU_PROVIDER=modal` flip plus a deploy,
not a rewrite. The scaling parameters mirror ../runpod/endpoint.json — a warm
floor of one, a hard ceiling, scale to zero after a short idle window — so the
cost model in ../COST.md holds for either provider.

**Updated by A26.** X05 wrote this against `apps/worker-ai/requirements-gpu.lock`
and a `montaj_worker_ai.gpu.model_server` module, neither of which existed. The
server is now a real app at `apps/model-server`, so this file installs that app's
lock file, runs that app's bake script, and serves that app's ASGI application.

Modal serves the FastAPI app directly with `@modal.asgi_app`, rather than wrapping
three methods, because it *is* an HTTP server: the worker's adapters
(`providers/serverless_whisper.py`, `diarisation/pyannote.py`, `lid.py`) speak
plain HTTP to `GPU_PROVIDER_URL`, so a Modal deployment that exposes the routes is
a URL change and nothing else. The RunPod queue lane, which is not HTTP, is what
`model_server/runpod_handler.py` is for.

Deploy (a [H] step; needs a Modal account and token):

    modal deploy infra/gpu/modal/app.py

Nothing here runs in CI and nothing here is applied by Terraform.
"""

from __future__ import annotations

import os

import modal

ENVIRONMENT = os.environ.get("MONTAJ_ENVIRONMENT", "staging")

#: Kept in step with ../runpod/endpoint.json and apps/model-server/Dockerfile.
WHISPER_MODEL = "large-v3-turbo"
ALIGNER_INDIC = "ai4bharat/indicwav2vec-hindi"
ALIGNER_GLOBAL = "jonatasgrosman/wav2vec2-large-xlsr-53-english"
DIARISER_MODEL = "pyannote/speaker-diarization-community-1"

# Weights are baked into the image for the same reason as on RunPod: a cold start
# that downloads 3 GB costs more in GPU-seconds than the layers cost in storage
# (../COST.md section 4).
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04",
        add_python="3.12",
    )
    .apt_install("ffmpeg", "libsndfile1")
    # The model server's own GPU lock file, compiled by pip-tools from
    # apps/model-server/pyproject.toml with the asr, align and diarise extras.
    .pip_install_from_requirements("apps/model-server/requirements-gpu.lock")
    .env(
        {
            "HF_HOME": "/models/hf",
            "TORCH_HOME": "/models/torch",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "MODEL_SERVER_DEVICE": "cuda",
            "MODEL_SERVER_COMPUTE_TYPE": "float16",
            "MODEL_SERVER_ALIGN_MODEL_DIR": "/models/align",
            "MODEL_SERVER_PRELOAD": "asr,align,diarise",
            "MONTAJ_ENVIRONMENT": ENVIRONMENT,
        }
    )
    # The same bake step the Dockerfile runs, so both providers ship identical
    # weights and the same ONNX export of the CTC heads (D77).
    .add_local_file(
        "apps/model-server/scripts/bake_models.py", "/tmp/bake_models.py", copy=True
    )
    .run_commands(
        "python /tmp/bake_models.py"
        f" --whisper {WHISPER_MODEL}"
        f" --aligner-indic {ALIGNER_INDIC}"
        f" --aligner-global {ALIGNER_GLOBAL}"
        f" --diariser {DIARISER_MODEL}"
        " --align-dir /models/align",
        secrets=[modal.Secret.from_name("montaj-hf-token")],
    )
    # The application itself, installed without dependencies: the lock file above
    # already resolved them.
    .add_local_dir("apps/model-server", "/app", copy=True)
    .run_commands("pip install --no-deps -e /app")
)

app = modal.App(f"montaj-asr-{ENVIRONMENT}", image=image)


@app.function(
    gpu="L4",
    # Decision D15: one warm instance per region so the first job of the day does
    # not pay a cold start.
    min_containers=1,
    # Ceiling, not a target. Unbounded GPU autoscaling is unbounded spend
    # (THREAT-MODEL T23).
    max_containers=20,
    # Two concurrent chunks fit in 24 GB alongside the aligner and the diariser.
    # The app's own dynamic batcher then coalesces them into one model call, which
    # is the lever D74's cost band depends on.
    max_concurrent_inputs=2,
    scaledown_window=30,
    timeout=1800,
    # GPU_PROVIDER_TOKEN lives here: the app refuses to boot without it.
    secrets=[
        modal.Secret.from_name("montaj-hf-token"),
        modal.Secret.from_name("montaj-gpu-provider-token"),
    ],
)
@modal.asgi_app()
def model_server():  # type: ignore[no-untyped-def]
    """The FastAPI application, models loaded by its own lifespan.

    Modal runs the ASGI lifespan, so `create_app`'s startup is what brings the
    weights into VRAM and starts the batch consumer — before the first request is
    accepted, and exactly once per container. `/readyz` stays false until it
    finishes.
    """
    from model_server.app import create_app

    return create_app()
