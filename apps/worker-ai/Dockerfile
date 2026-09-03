# CPU image for the AI worker: BullMQ consumer, VAD, chunking, alignment, evals.
#
# Build context is `apps/worker-ai` so the image never sees the rest of the
# monorepo:
#
#   docker build -f apps/worker-ai/Dockerfile apps/worker-ai
#
# What this image is for: the CPU pool of `05 §10` — VAD, chunk planning,
# alignment, diarisation and the vendor ASR adapters, all of which are network- or
# CPU-bound. Whisper inference on a GPU is `Dockerfile.gpu`.

# ---------------------------------------------------------------------------
# Stage 1 — build the wheel, so the runtime image carries no build toolchain
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS build

WORKDIR /build

RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1 build==1.3.0

COPY pyproject.toml README.md ./
COPY worker_ai ./worker_ai

RUN python -m build --wheel --outdir /dist

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# ffmpeg cuts the chunks the VAD plan defines; ca-certificates is needed for the
# vendor and callback HTTPS calls. `--no-install-recommends` keeps the layer small.
#
# The apt versions are deliberately NOT pinned: Debian's security archive drops
# the superseded build the moment it publishes a fix, so a pinned line turns every
# rebuild after a CVE into a failure. The reproducibility pin that matters is the
# base image tag, and the Python side is pinned exactly in `requirements.lock`.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pinned transitive dependencies first: this layer changes only when the lock
# does, so a code change rebuilds in seconds.
COPY requirements.lock ./
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1 \
    && python -m pip install --no-cache-dir -r requirements.lock

# faster-whisper is the `local-asr` extra: it is in the image (the CPU pool is the
# offline fallback lane) but not in the lock, because CI must not download
# CTranslate2 and a model to run the unit suite.
RUN python -m pip install --no-cache-dir faster-whisper==1.2.1

COPY --from=build /dist/*.whl /tmp/
RUN python -m pip install --no-cache-dir --no-deps /tmp/*.whl && rm -f /tmp/*.whl

# The Silero v5 ONNX graph (~2 MB) is fetched at build time rather than committed
# to the repository or downloaded at boot: a pod that has to reach the internet to
# become healthy is a pod that fails its readiness probe during an incident.
ADD --chmod=444 \
    https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx \
    /opt/models/silero_vad.onnx
# `ADD --chmod=444` applies that mode to the directory it implicitly creates
# too, not just the file — `/opt/models` came out `dr--r--r--` (no execute
# bit), which makes it untraversable even by the `worker` user below
# (`PermissionError` on `stat`, caught by M17 bringing up the full e2e
# stack). Fix the directory back to a normal `755` while leaving the file
# itself read-only.
RUN chmod 755 /opt/models
ENV WORKER_AI_VAD_MODEL=/opt/models/silero_vad.onnx

# Model and Hugging Face caches live on a writable volume; the image itself stays
# read-only, which is what the Helm chart's securityContext expects (X05).
ENV HF_HOME=/var/cache/montaj/huggingface \
    XDG_CACHE_HOME=/var/cache/montaj \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_AI_PORT=8091

RUN useradd --system --create-home --uid 10001 worker \
    && mkdir -p /var/cache/montaj \
    && chown -R worker:worker /var/cache/montaj
USER worker

# Pod-internal only: the control app has no authentication and the Service that
# fronts it is never published (see README).
EXPOSE 8091

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('WORKER_AI_PORT','8091')+'/health',timeout=4).status==200 else 1)"

CMD ["python", "-m", "worker_ai"]
