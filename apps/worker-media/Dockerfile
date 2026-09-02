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
