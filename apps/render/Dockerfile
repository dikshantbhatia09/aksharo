# Image for the cloud render service: BullMQ consumer, Skia via @napi-rs/canvas,
# ffmpeg overlay and encode.
#
# The build context is the **repository root**, because this app is a workspace
# package and pnpm needs the lockfile and the packages it depends on:
#
#   docker build -f apps/render/Dockerfile .
#
# What this image is for: the CPU render pool of `05 §10`. There is no headless
# Chromium and no Remotion in it (decision D33) — the browser, the desktop app
# and this service execute the same `DrawCommand[]`, which is what makes the
# parity gate meaningful.

# ---------------------------------------------------------------------------
# Stage 1 — install and build the workspace
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/usr/local/bin
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /repo

# Manifests first: this layer changes only when a dependency does, so a code
# change rebuilds without re-resolving the whole workspace.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/edg/package.json ./packages/edg/
COPY packages/timemap/package.json ./packages/timemap/
COPY packages/caption-styles/package.json ./packages/caption-styles/
COPY packages/render-core/package.json ./packages/render-core/
COPY packages/render-manifest/package.json ./packages/render-manifest/
COPY packages/render-skia-node/package.json ./packages/render-skia-node/
COPY apps/render/package.json ./apps/render/

RUN pnpm install --frozen-lockfile --filter @montaj/render...

COPY packages/config ./packages/config
COPY packages/edg ./packages/edg
COPY packages/timemap ./packages/timemap
COPY packages/caption-styles ./packages/caption-styles
COPY packages/render-core ./packages/render-core
COPY packages/render-manifest ./packages/render-manifest
COPY packages/render-skia-node ./packages/render-skia-node
COPY apps/render ./apps/render

RUN pnpm --filter @montaj/render... build \
    && pnpm --filter @montaj/render... --prod deploy /app --legacy

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# ffmpeg does everything except the captions: decode, cut, scale, crop,
# composite, encode, mux. There is no pure-JS fallback, so a missing binary is a
# boot failure (`assertMediaToolsAvailable`).
#
# **Version.** Bookworm ships ffmpeg 7.x; the service is developed against 9.x
# and refuses anything below major 6 (`src/ffmpeg/tools.ts`). Both are ABI-fine
# for this filter graph, and the pin that actually matters for output stability
# is the base image tag. When the image moves to a build with a different libass
# configuration, re-run D35's `shaping=complex` check against the Devanagari and
# Tamil fixtures before shipping.
#
# The apt versions are deliberately NOT pinned: Debian's security archive drops
# the superseded build the moment it publishes a fix, so a pinned line turns
# every rebuild after a CVE into a failure.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app ./

# Scratch space for the downloaded source and the encoder's output. It is a
# volume in the chart: a render writes gigabytes and the image stays read-only.
ENV RENDER_WORK_DIR=/var/cache/montaj/render \
    NODE_ENV=production

RUN useradd --system --create-home --uid 10001 render \
    && mkdir -p /var/cache/montaj/render \
    && chown -R render:render /var/cache/montaj
USER render

# No port: this service consumes a queue and calls the API. It is never fronted
# by a Service and has nothing to serve.

# `ffmpeg -version` is the liveness signal that matters — the process cannot do
# its job without it, and a Node process that is merely alive is not healthy.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
    CMD ffmpeg -version > /dev/null 2>&1 || exit 1

CMD ["node", "apps/render/dist/index.js"]
