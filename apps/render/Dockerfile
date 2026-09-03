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
# `pnpm deploy` (below) re-resolves the whole workspace manifest and fails
# `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` if a `workspace:*` reference in any
# copied package.json — even a devDependency, which `--prod` then skips
# installing — cannot be found in the visible workspace. `@montaj/fonts` and
# `@montaj/render-canvaskit` are devDependencies-only of `apps/render`
# (tooling/tests), so only their manifests are needed here, not their source.
COPY packages/fonts/package.json ./packages/fonts/
COPY packages/render-canvaskit/package.json ./packages/render-canvaskit/
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

# `pnpm deploy` in 9.x has no `--legacy` flag (that was a pre-9 pnpm option);
# passing it is a hard error ("Unknown option: 'legacy'"). The default
# (non-legacy) deploy strategy hard-links `node_modules` into the target
# directory, which is what the runtime stage below expects.
#
# `deploy` also refuses a filter that matches more than one project
# ("Cannot deploy more than 1 project") — `@montaj/render...` matches render
# plus every workspace dependency it needs to build first, so the build step
# keeps that filter while the deploy step targets `@montaj/render` alone;
# `pnpm deploy` resolves and hard-links its workspace dependencies itself.
#
# `@montaj/render...` also pulls in `apps/render`'s devDependencies-only
# workspace members (`@montaj/fonts`, `@montaj/render-canvaskit` — tooling and
# tests, not runtime code), whose manifests are present above only so `pnpm
# deploy`'s workspace validation can resolve their `workspace:*` reference;
# their source was never copied in, so building them fails. Exclude them from
# the build.
RUN pnpm --filter @montaj/render... --filter '!@montaj/fonts' --filter '!@montaj/render-canvaskit' build \
    && pnpm --filter @montaj/render --prod deploy /app

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
# `workers/raster-worker.mjs` is loaded by `worker_threads` at runtime and is not
# part of the `tsc` output, so it is copied explicitly rather than trusted to
# whatever `pnpm deploy` decided about a package with no `files` field.
COPY --from=build /repo/apps/render/workers ./apps/render/workers

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
