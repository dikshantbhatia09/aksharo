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
    // comment. Run it now, inside the container, against `localhost` there.
    run(["exec", "api", "pnpm", "--filter", "@montaj/api", "db:seed:sample"]);
    break;
  case "down":
    run(["down", "-v"]);
    break;
  default:
    console.error("usage: pnpm e2e:stack <up|down>");
    process.exit(1);
}
