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
    // comment. It used to run inside the container via `docker compose
    // exec`, but `api`'s image (M17) is now a `pnpm deploy --prod` runtime
    // with no devDependencies — `tsx` (which `db:seed:sample` needs) is not
    // on PATH there. Run it on the HOST instead, against the stack's exposed
    // port: `seed-sample.ts` only ever talks to `API_ORIGIN` over HTTP plus
    // Prisma directly, both of which work the same from outside the compose
    // network as long as `.env` points at the exposed ports.
    {
      const seedResult = spawnSync("pnpm", ["--filter", "@montaj/api", "db:seed:sample"], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      if (seedResult.status !== 0) {
        process.exit(seedResult.status ?? 1);
      }
    }
    break;
  case "down":
    run(["down", "-v"]);
    break;
  default:
    console.error("usage: pnpm e2e:stack <up|down>");
    process.exit(1);
}
