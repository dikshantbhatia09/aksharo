"""Modal equivalent of the RunPod endpoint (decision D15 says "RunPod/Modal class").

Kept deliberately small: it exists so that a RunPod outage, a price move or a
capacity squeeze in the AP region is a `GPU_PROVIDER=modal` flip plus a deploy,
not a rewrite. The scaling parameters mirror ../runpod/endpoint.json — a warm
floor of one, a hard ceiling, scale to zero after a short idle window — so the
cost model in ../COST.md holds for either provider.

Deploy (a [H] step; needs a Modal account and token):

    modal deploy infra/gpu/modal/app.py

Nothing here runs in CI and nothing here is applied by Terraform.
"""

from __future__ import annotations

import os

import modal

ENVIRONMENT = os.environ.get("MONTAJ_ENVIRONMENT", "staging")

# Weights are baked into the image for the same reason as on RunPod: a cold
# start that downloads 3 GB costs more in GPU-seconds than the layers cost in
# storage.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04",
        add_python="3.12",
    )
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install_from_requirements("apps/worker-ai/requirements-gpu.lock")
    .env(
        {
            "HF_HOME": "/models/hf",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "COMPUTE_TYPE": "float16",
        }
    )
    # The same bake step the RunPod Dockerfile runs, so both providers ship
    # byte-identical weights.
    .add_local_file(
        "infra/gpu/runpod/bake_models.py", "/tmp/bake_models.py", copy=True
    )
    .run_commands(
        "python /tmp/bake_models.py"
        " --whisper large-v3-turbo"
        " --aligner jonatasgrosman/wav2vec2-large-xlsr-53-english"
        " --diariser pyannote/speaker-diarization-community-1",
        secrets=[modal.Secret.from_name("montaj-hf-token")],
    )
)

app = modal.App(f"montaj-asr-{ENVIRONMENT}", image=image)


@app.cls(
    gpu="L4",
    # Decision D15: one warm instance per region so the first job of the day
    # does not pay a cold start.
    min_containers=1,
    # Ceiling, not a target. Unbounded GPU autoscaling is unbounded spend
    # (THREAT-MODEL T23).
    max_containers=20,
    # Two concurrent chunks fit in 24 GB alongside the aligner and diariser.
    allow_concurrent_inputs=2,
    scaledown_window=30,
    timeout=1800,
    secrets=[modal.Secret.from_name("montaj-hf-token")],
)
class ModelServer:
    """Whisper large-v3-turbo, forced alignment and pyannote, co-resident."""

    @modal.enter()
    def load(self) -> None:
        # Import inside the container: these packages do not exist locally.
        from montaj_worker_ai.gpu.model_server import ModelServer as Impl

        self._impl = Impl()
        self._impl.load()

    @modal.method()
    def transcribe(self, payload: dict) -> dict:
        """One VAD-aligned chunk in, transcript chunk out.

        The envelope and the completion callback are the API's business
        (CONTRACTS section 3); this returns the raw result and the usage counters
        the caller needs to settle credits.
        """
        return self._impl.transcribe(payload)

    @modal.method()
    def align(self, payload: dict) -> dict:
        return self._impl.align(payload)

    @modal.method()
    def diarise(self, payload: dict) -> dict:
        return self._impl.diarise(payload)
