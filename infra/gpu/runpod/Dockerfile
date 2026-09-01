# =============================================================================
# GPU model-server image for the serverless ASR endpoint (decision D15).
#
# Everything the AI worker needs at inference time is baked in: Whisper
# large-v3-turbo, the forced-alignment model and pyannote community-1. A cold
# start that downloads 3 GB of weights burns more in GPU-seconds than the extra
# image layers cost in registry storage, and it makes the p95 in 05 section 5.1
# a lottery.
#
# The handler itself lives in apps/worker-ai and is copied in by the application
# build; this file owns the base image, the CUDA/cuDNN stack and the weights.
#
# Build (from the repository root):
#   docker build -f infra/gpu/runpod/Dockerfile \
#     --build-arg HF_TOKEN=... \
#     -t <registry>/montaj/gpu-model-server:<tag> .
#
# HF_TOKEN is needed only at build time for the gated pyannote weights. It is a
# BuildKit secret, never an ARG that lands in a layer (THREAT-MODEL T21).
# =============================================================================

ARG CUDA_IMAGE=nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04
FROM ${CUDA_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    TORCH_HOME=/models/torch

# ffmpeg is needed for decode and resampling inside the model server; the rest is
# the minimum to build the Python wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.12 \
        python3.12-venv \
        python3-pip \
        ffmpeg \
        libsndfile1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# ---------------------------------------------------------------------------
# Dependencies. Pinned in a lock file owned by the AI worker (CONTRACTS section
# 10 freezes the toolchain until Gate A), so the image and the CPU worker cannot
# drift apart.
# ---------------------------------------------------------------------------
COPY apps/worker-ai/requirements-gpu.lock /tmp/requirements-gpu.lock
RUN pip install --no-cache-dir -r /tmp/requirements-gpu.lock

# ---------------------------------------------------------------------------
# Weights. Downloaded once, at build time, into the image.
# ---------------------------------------------------------------------------
FROM base AS models

ARG MODEL_WHISPER=large-v3-turbo
ARG MODEL_ALIGNER=jonatasgrosman/wav2vec2-large-xlsr-53-english
ARG MODEL_DIARISER=pyannote/speaker-diarization-community-1

COPY infra/gpu/runpod/bake_models.py /tmp/bake_models.py

RUN --mount=type=secret,id=hf_token,required=false \
    HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || true)" \
    python /tmp/bake_models.py \
        --whisper "${MODEL_WHISPER}" \
        --aligner "${MODEL_ALIGNER}" \
        --diariser "${MODEL_DIARISER}" \
    && rm /tmp/bake_models.py

# ---------------------------------------------------------------------------
# Final image.
# ---------------------------------------------------------------------------
FROM models AS runtime

# Offline at run time: if a weight is missing the container must fail loudly on
# boot, not silently reach out to huggingface.co from inside a GPU worker.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=4 \
    COMPUTE_TYPE=float16

WORKDIR /app

COPY apps/worker-ai/pyproject.toml /app/pyproject.toml
COPY apps/worker-ai/src /app/src

RUN pip install --no-cache-dir --no-deps -e /app

# Serverless workers run as root inside a single-tenant sandbox; the Kubernetes
# CPU variant of this worker runs as non-root under the chart's pod security
# context. Documented rather than silently different.
RUN python -c "import sys; print('python', sys.version)"

CMD ["python", "-m", "montaj_worker_ai.gpu.handler"]
