# Image for the web app (Next.js 15): built once at image build time, no
# `pnpm install`/`next build` at container boot (same reasoning as
# `apps/api/Dockerfile`; see CHANGELOG M17).
#
# Build context is the REPO ROOT — a pnpm workspace package cannot be
# installed in isolation.
#
#   docker build -f apps/web/Dockerfile -t montaj/web .

# ---------------------------------------------------------------------------
# Stage 1 — prune the workspace to `@montaj/web` and its dependents
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
RUN corepack enable
COPY . .
RUN npx --yes turbo@2.10.12 prune @montaj/web --docker

# ---------------------------------------------------------------------------
# Stage 2 — install once from the pruned lockfile, then build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# `next build` reads `API_ORIGIN`/`WEB_ORIGIN` only at request time (server
# components) or via `NEXT_PUBLIC_*` at build time; none of the compose env
# is build-time-required here, so no extra ENV is needed for this step.
RUN pnpm turbo run build --filter=@montaj/web

# ---------------------------------------------------------------------------
# Stage 3 — deploy (prod-only dependency tree, plus `typescript`)
# ---------------------------------------------------------------------------
# `next start` loads `next.config.ts` at boot with its own on-the-fly
# TypeScript compilation, which needs a `typescript` package present —
# without one, Next tries to auto-install it via `yarn add` (no lockfile, no
# network egress once the container is running), which fails and takes the
# whole container down ("Failed to load next.config.ts", caught by M17
# bringing up the full e2e stack). Rather than keep every devDependency
# (`pnpm deploy` without `--prod` — correct, but ~4.5 GB per image, the
# difference between this host's shared disk staying above or below the
# verify-wave guard), add just the one package `next start` actually needs at
# boot, pinned to the workspace's own version.
FROM build AS deploy
WORKDIR /repo
# `pnpm add` inside the already-deployed `/app` tree fails
# (`ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF` — its `node_modules` was written by
# `deploy`'s own hard-link strategy, not a normal install, and corepack then
# tries to fetch a different pnpm major to reconcile it). Copy the package
# across from Stage 2's store instead, same approach as `apps/api/Dockerfile`
# uses for the generated Prisma client.
RUN pnpm --filter @montaj/web --prod deploy --ignore-scripts /app \
    && SRC=$(find /repo/node_modules/.pnpm -maxdepth 1 -iname 'typescript@*' | head -n1) \
    && test -n "$SRC" \
    && mkdir -p /app/node_modules/.pnpm \
    && cp -r "$SRC" /app/node_modules/.pnpm/ \
    && ln -s ".pnpm/$(basename "$SRC")/node_modules/typescript" /app/node_modules/typescript

# ---------------------------------------------------------------------------
# Stage 4 — runtime (only the deployed tree)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=deploy /app ./

ENV NODE_ENV=production

RUN useradd --system --create-home --uid 10001 web \
    && chown -R web:web /app
USER web

HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=20 \
    CMD node -e "fetch('http://localhost:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `pnpm deploy` flattens the deployed package to the target directory root
# (see `apps/api/Dockerfile`'s note), so `next`'s CLI sits at
# `/app/node_modules/.bin/next`, and `.next/` (the build output) directly
# under `/app`.
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
