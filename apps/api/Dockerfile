# Image for the API: NestJS HTTP server, built once at image build time (no
# `pnpm install`/`nest build` at container boot — that is what previously made
# `montaj-e2e-api` run a full monorepo install inside the compose `--wait`
# health window and time out; see CHANGELOG M17).
#
# Build context is the REPO ROOT (same reason as `apps/worker-media/Dockerfile`):
# a pnpm workspace package cannot be installed in isolation.
#
#   docker build -f apps/api/Dockerfile -t montaj/api .
#
# Same `turbo prune` shape as `apps/worker-media/Dockerfile`: install layer pays
# for only `@montaj/api` and its workspace dependencies, not the whole monorepo.
#
# Two build targets:
#   * `migrate` — the full pruned install (devDependencies included, so the
#     `prisma` CLI and `tsx` are on PATH) plus the built workspace, used as a
#     one-shot compose service that runs `prisma migrate deploy` then the base
#     seed before the API is allowed to start (compose `depends_on:
#     service_completed_successfully`).
#   * `runtime` (default) — `pnpm deploy --prod`, so the shipped image has no
#     dev tooling and no repo source, only the built `dist/` and prod deps.

# ---------------------------------------------------------------------------
# Stage 1 — prune the workspace to `@montaj/api` and its dependents
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS pruner
WORKDIR /repo
RUN corepack enable
COPY . .
RUN npx --yes turbo@2.10.12 prune @montaj/api --docker

# ---------------------------------------------------------------------------
# Stage 2 — install once from the pruned lockfile, then build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --from=pruner /repo/out/json/ .
# `turbo prune --docker`'s `out/json` layer is package.json files only (by
# design, so this layer is cache-busted by a dependency bump, not a source
# edit) — but api's own `postinstall` (`node scripts/prisma-generate.mjs`)
# needs that script to exist before `pnpm install` even runs it. Copy it in
# explicitly; it is tiny and rarely changes, so this does not meaningfully
# hurt the cache.
COPY apps/api/scripts ./apps/api/scripts
# Same reason: `prisma generate` reads `prisma/schema.prisma` from the
# package's own directory, which `out/json` also does not carry.
COPY apps/api/prisma ./apps/api/prisma
# `prisma generate` (api's `postinstall`) needs a syntactically valid
# `DATABASE_URL` to parse, even though it never connects — a build-time
# placeholder is enough (`scripts/prisma-generate.mjs` falls back to one on
# its own, but the workspace's other packages' postinstalls also run here).
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma?schema=public"
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@montaj/api

# ---------------------------------------------------------------------------
# Stage 3a — migrate + seed (one-shot compose service, full install kept)
# ---------------------------------------------------------------------------
FROM build AS migrate
WORKDIR /repo
CMD ["sh", "-c", "pnpm --filter @montaj/api exec prisma migrate deploy && pnpm --filter @montaj/api exec tsx prisma/seed.ts"]

# ---------------------------------------------------------------------------
# Stage 3b — deploy (prod-only dependency tree, still inside the full /repo
# build context so `pnpm deploy` can resolve workspace deps)
# ---------------------------------------------------------------------------
FROM build AS deploy
WORKDIR /repo
# `--ignore-scripts`: `pnpm deploy`'s own postinstall would try `prisma
# generate` again, but the deployed tree has no devDependencies, so the
# `prisma` CLI binary is not on PATH there.
#
# `pnpm deploy` re-resolves `@prisma/client`'s own pnpm-store entry rather
# than hard-linking Stage 2's already-generated one, so the generated client
# (`.prisma/client`, physically stored *inside* `@prisma/client`'s own
# `node_modules` in the pnpm virtual store — verified by inspecting the
# already-built `montaj-e2e-render` image's install) is missing from `/app`
# after deploy even though `@prisma/client` itself is there. Copy it across
# from Stage 2's store entry, which has the identical `@prisma+client@<ver>`
# hash because both installs come from the same lockfile.
RUN pnpm --filter @montaj/api --prod deploy --ignore-scripts /app \
    && SRC=$(find /repo/node_modules/.pnpm -maxdepth 1 -iname '@prisma+client@*' | head -n1) \
    && DEST=$(find /app/node_modules/.pnpm -maxdepth 1 -iname '@prisma+client@*' | head -n1) \
    && test -n "$SRC" && test -n "$DEST" \
    && cp -r "$SRC/node_modules/.prisma" "$DEST/node_modules/.prisma"
# `scripts/e2e-stack.mjs`'s post-`up` `db:seed:sample` step needs `tsx` (a
# devDependency, so absent from `--prod`) run *inside* this container rather
# than on the host: `seed-sample.ts` mints its own access token with `iss`
# set to `API_ORIGIN`, which the running API validates against its own
# `API_ORIGIN` — the container's (`http://api:3001`), not the host's exposed
# port. Running the script on the host makes those two origins disagree and
# every minted token comes back `common/unauthorized` (caught by M17 running
# the full e2e stack for the first time). `pnpm`'s isolated `node_modules`
# makes copying a single package across from Stage 2's store impractical
# (its own dependencies are symlinks into sibling store entries this image
# does not otherwise ship) — a plain `npm install` pulls `tsx` and its full,
# self-contained dependency tree in one step instead, pinned to the
# workspace's own devDependency version.
RUN mkdir /tmp/tsx-install \
    && npm install --no-save --prefix /tmp/tsx-install tsx@4.23.13 \
    && cp -r /tmp/tsx-install/node_modules/. /app/node_modules/ \
    && rm -rf /tmp/tsx-install

# ---------------------------------------------------------------------------
# Stage 3c — runtime (only the deployed tree, not the whole monorepo)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deploy /app ./

ENV NODE_ENV=production

RUN useradd --system --create-home --uid 10001 api \
    && chown -R api:api /app
USER api

# Fast boot now that nothing installs or builds at container start — sized to
# the real cold-start of `node dist/main.js` (Nest module graph + Prisma
# engine load), not to a `pnpm install`.
HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=20 \
    CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `pnpm deploy` flattens the deployed package to the target directory root
# (verified against the already-built `montaj-e2e-render` image: `/app/dist`,
# not `/app/apps/render/dist` — that sibling image's own CMD path is stale and
# out of this work package's file boundary to fix), so `dist/main.js` sits
# directly under `/app`, not under `/app/apps/api`.
CMD ["node", "dist/main.js"]
