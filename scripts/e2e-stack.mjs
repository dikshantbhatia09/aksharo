#!/usr/bin/env node
/**
 * `pnpm e2e:stack up|down` — thin wrapper around `docker compose -f
 * docker-compose.test.yml`, so the brief's one-command interface exists
 * without a shell script (Windows host, `05-build`'s cross-platform rule).
 *
 *   pnpm e2e:stack up     -> docker compose -p montaj-e2e -f docker-compose.test.yml up -d --build --wait
 *   pnpm e2e:stack down   -> docker compose -p montaj-e2e -f docker-compose.test.yml down -v
 */
import { spawnSync } from "node:child_process";

const action = process.argv[2];

const COMPOSE_ARGS = ["-p", "montaj-e2e", "-f", "docker-compose.test.yml"];

function run(args) {
  const result = spawnSync("docker", ["compose", ...COMPOSE_ARGS, ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

switch (action) {
  case "up":
    run(["up", "-d", "--build", "--wait"]);
    // `db:seed:sample` needs the API already listening (it drives the real
    // `POST /transcribe` path) — see docker-compose.test.yml's `api` service
    // comment. Must run INSIDE the container, not on the host: the script
    // mints its own access token with `iss` set to `API_ORIGIN`, which the
    // running API validates against its own `API_ORIGIN` — the container's
    // (`http://api:3001`), not the host's exposed port. Running it on the
    // host makes those two origins disagree and every minted token comes
    // back `common/unauthorized` (found bringing up the full stack for M17).
    // `api`'s image is a `pnpm deploy --prod` runtime with no
    // devDependencies, so `apps/api/Dockerfile`'s `runtime` target installs
    // `tsx` on its own (not through the workspace) specifically so this can
    // still run without a full devDependency image.
    run(["exec", "api", "node_modules/.bin/tsx", "prisma/seed-sample.ts"]);
    break;
  case "down":
    run(["down", "-v"]);
    break;
  default:
    console.error("usage: pnpm e2e:stack <up|down>");
    process.exit(1);
}
