# =============================================================================
# The GPU model-server image (decision D15).
#
# Everything the AI worker needs at inference time is baked in: faster-whisper
# large-v3-turbo, the CTC forced aligners of D77 and pyannote community-1. A cold
# start that downloads 3 GB of weights burns more in GPU-seconds than the extra
# layers cost in registry storage, and it makes the p95 in `05 §5.1` a lottery
# (infra/gpu/COST.md §4).
#
# Build, with `apps/model-server` as the context:
#
#   printf '%s' "$HF_TOKEN" > /tmp/hf_token
#   DOCKER_BUILDKIT=1 docker build \
#     -f apps/model-server/Dockerfile \
#     --secret id=hf_token,src=/tmp/hf_token \
#     -t <registry>/montaj/gpu-model-server:<tag> apps/model-server
#   shred -u /tmp/hf_token
#
# HF_TOKEN is needed only at build time, for the gated pyannote weights. It is a
# BuildKit secret and never an ARG or an ENV, so it cannot land in a layer
# (THREAT-MODEL T21).
#
# CI builds this file with --target cpu, which skips every weight and every CUDA
# dependency: it proves the Dockerfile and the app install, on a runner with no
# GPU and no Hugging Face token. The default target is the real CUDA runtime.
# =============================================================================

ARG CUDA_IMAGE=nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04
ARG PYTHON_IMAGE=python:3.12-slim-bookworm


# -----------------------------------------------------------------------------
# 1. CPU smoke target — no CUDA, no weights, no HF token.
#
# First so `--target cpu` never pulls the 4 GB CUDA base. What it proves is
# exactly what CI can prove without a card: the lock file resolves, the package
# installs, and the app imports and answers /healthz.
# -----------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS cpu

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_SERVER_DEVICE=cpu \
    MODEL_SERVER_COMPUTE_TYPE=int8

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

COPY pyproject.toml README.md ./
COPY model_server ./model_server
RUN pip install --no-cache-dir --no-deps -e .

# A non-root user for the CPU lane, matching the chart's pod security context.
RUN useradd --system --uid 10001 --create-home aksharo
USER 10001

EXPOSE 8000
CMD ["python", "-m", "model_server"]


# -----------------------------------------------------------------------------
# 2. CUDA base: the interpreter, ffmpeg and the pinned Python stack.
# -----------------------------------------------------------------------------
FROM ${CUDA_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    TORCH_HOME=/models/torch \
    MODEL_SERVER_ALIGN_MODEL_DIR=/models/align

# ffmpeg decodes anything that is not already audio16k.wav; libsndfile is
# pyannote's reader. The rest is the minimum to build the wheels.
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

# requirements-gpu.lock is this app's lock file, compiled by pip-tools from
# pyproject.toml with the asr, align, diarise, bake and runpod extras. It
# replaces the `apps/worker-ai/requirements-gpu.lock` X05 referenced, which
# never existed.
COPY requirements-gpu.lock /tmp/requirements-gpu.lock
RUN pip install --no-cache-dir -r /tmp/requirements-gpu.lock


# -----------------------------------------------------------------------------
# 3. Weights, downloaded once, at build time.
#
# scripts/bake_models.py is the single bake step for both providers: this file
# runs it here, and infra/gpu/modal/app.py runs the same script, so RunPod and
# Modal ship identical weights and an identical ONNX export of the CTC heads.
# -----------------------------------------------------------------------------
FROM base AS models

ARG MODEL_WHISPER=large-v3-turbo
ARG MODEL_ALIGNER_INDIC=ai4bharat/indicwav2vec-hindi
ARG MODEL_ALIGNER_GLOBAL=jonatasgrosman/wav2vec2-large-xlsr-53-english
ARG MODEL_DIARISER=pyannote/speaker-diarization-community-1

COPY scripts/bake_models.py /tmp/bake_models.py

# The aligner export needs transformers, onnx and torch. All three are in
# requirements-gpu.lock (the `bake` extra) rather than a throwaway stage: a
# multi-stage venv copy to save ~60 MB is not worth the complexity next to 3 GB
# of weights, and having the export tools in the image makes a debug re-export
# possible without a rebuild.
RUN --mount=type=secret,id=hf_token,required=false \
    HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || true)" \
    python /tmp/bake_models.py \
        --whisper "${MODEL_WHISPER}" \
        --aligner-indic "${MODEL_ALIGNER_INDIC}" \
        --aligner-global "${MODEL_ALIGNER_GLOBAL}" \
        --diariser "${MODEL_DIARISER}" \
        --align-dir "${MODEL_SERVER_ALIGN_MODEL_DIR}" \
    && rm /tmp/bake_models.py


# -----------------------------------------------------------------------------
# 4. Runtime.
# -----------------------------------------------------------------------------
FROM models AS runtime

# Offline at run time on purpose: a missing weight must fail the container on
# boot, not quietly reach out to huggingface.co from inside a GPU worker that is
# holding user media.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=4 \
    MODEL_SERVER_DEVICE=cuda \
    MODEL_SERVER_COMPUTE_TYPE=float16 \
    MODEL_SERVER_PRELOAD=asr,align,diarise \
    MODEL_SERVER_MODE=http

WORKDIR /app

COPY pyproject.toml README.md ./
COPY model_server ./model_server
RUN pip install --no-cache-dir --no-deps -e .

# Serverless workers run as root inside a single-tenant sandbox; the Kubernetes
# CPU variant runs as non-root under the chart's pod security context. Documented
# rather than silently different.

# The image is the unit of rollback, so it says what it is.
RUN python -c "import model_server, sys; print('model-server', model_server.__version__, 'on', sys.version)"

EXPOSE 8000

# MODEL_SERVER_MODE picks the lane: `http` runs uvicorn (Modal, RunPod
# load-balancing endpoints, local); `runpod` runs the queue handler. Both drive
# the same app, the same batcher and the same warm models.
CMD ["sh", "-c", "if [ \"$MODEL_SERVER_MODE\" = \"runpod\" ]; then exec python -m model_server.runpod_handler; else exec python -m model_server; fi"]
