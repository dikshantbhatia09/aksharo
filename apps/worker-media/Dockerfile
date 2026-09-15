# Node image for the media worker: BullMQ consumer, ffprobe/ffmpeg, no HTTP server.
#
# Build context is the REPO ROOT, not this directory, because a pnpm workspace
# package cannot be installed in isolation — its lockfile and its `workspace:*`
# dependency (`@montaj/config`) live there:
#
#   docker build -f apps/worker-media/Dockerfile -t montaj/worker-media .
#
# `apps/worker-media/Dockerfile.dockerignore` trims that context to source plus
# every workspace's `package.json` (Turborepo needs those to compute the prune
# below); BuildKit picks it up automatically because it is named after this file.
#
# Four stages: `turbo prune` first works out which of the *other* 16 workspace
# packages this one actually needs (in practice just `@montaj/config`), so the
# `install` layer — the one that is cache-busted by any dependency bump — pays
# for one package's dependencies rather than the whole monorepo's.

# ---------------------------------------------------------------------------
# Stage 1 — prune the workspace to `@montaj/worker-media` and its dependents
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS pruner
WORKDIR /repo
RUN corepack enable
COPY . .
RUN npx --yes turbo@2.10.12 prune @montaj/worker-media --docker

# ---------------------------------------------------------------------------
# Stage 2 — install once from the pruned lockfile, then build
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS build
WORKDIR /repo
RUN corepack enable
# `out/json` is package.json files only (plus the lockfile), so this layer is
# cached until a dependency actually changes rather than on every source edit.
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# `^build` in turbo.json builds `@montaj/config` first; a package that imported
# the other's TypeScript source directly would not need this, but `Settings`
# imports `@montaj/config`'s compiled `dist/`, same as the runtime will.
RUN pnpm turbo run build --filter=@montaj/worker-media

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS runtime

# ffmpeg is the whole reason this worker exists; ca-certificates is needed to
# read a raw object over the presigned HTTPS URL and to POST the signed
# callbacks. Debian trixie ships ffmpeg 7.x, which clears `MINIMUM_FFMPEG_MAJOR`
# (6) in `src/media-tools.ts` — the worker checks this itself at boot and
# refuses to start on an older build rather than silently producing flat HDR
# proxies and reporting no progress.
#
# The apt versions are deliberately NOT pinned: Debian's security archive drops
# the superseded build the moment it publishes a fix, so a pinned line turns
# every rebuild after a CVE into a failure. The pin that matters for
# reproducibility is the base image tag.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp for `media.acquire` (REP-010, ADR 0002 section 7).
#
# Pinned to one release and verified against a digest, unlike the apt packages
# above. The difference is deliberate: ffmpeg processes bytes we already hold,
# while this fetches bytes from the public internet using a URL a user supplied,
# so the binary that runs has to be the binary that was reviewed. The official
# standalone build is used rather than pip, so there is no dependency resolution
# between the review and the run.
#
# The worker refuses to start when the version or the digest does not match, so
# this image cannot acquire with a different downloader than the one it shipped.
#
# YT_DLP_SHA256 has no default on purpose: until the publisher's digest is
# recorded (docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md) this
# build argument must be supplied explicitly, and a build without it fails HERE
# rather than shipping an executable nobody identified.
ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256
# The build argument is checked FIRST, so a build without it fails before it
# installs anything or touches the network.
RUN test -n "${YT_DLP_SHA256}" \
    || { echo 'YT_DLP_SHA256 build argument is required; see ADR 0002 section 7' >&2; exit 1; }

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl \
    && curl -fsSL --proto '=https' --tlsv1.2 \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" \
        -o /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp

WORKDIR /app
COPY --from=build /repo .

ENV NODE_ENV=production

# `WORKER_MEDIA_TEMP_DIR` gets its own writable directory rather than the image
# default `/tmp`: the base image's `/tmp` is world-writable, and a scratch
# directory that every job shares with anything else on the box is not the
# isolation `withWorkspace()` is trying to buy.
RUN useradd --system --create-home --uid 10001 worker \
    && mkdir -p /var/cache/montaj/tmp \
    && chown -R worker:worker /var/cache/montaj
ENV WORKER_MEDIA_TEMP_DIR=/var/cache/montaj/tmp
USER worker

# Pod-internal only: this is a BullMQ consumer with no listening port and no
# HTTP health endpoint (unlike `worker-ai`'s control app). Liveness is "the
# process is running"; readiness is "ffmpeg and Redis were both fine at boot",
# which `assertMediaToolsAvailable()` already refuses to start without — a
# container that reaches CMD has already passed it. `05 §10`'s KEDA scaling
# reads BullMQ queue depth directly rather than a health endpoint on the worker.

CMD ["node", "apps/worker-media/dist/index.js"]
