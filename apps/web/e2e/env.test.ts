import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEnv, redisKeyPrefix } from "./env";

/**
 * A plain `node:test` file, not a Vitest one: the shared Vitest preset
 * (`packages/config/vitest.base.mjs`) excludes all of `**\/e2e/**` — correctly,
 * since that is Playwright's directory in every other package — and narrowing
 * that shared exclusion is out of this work package's file boundary. Run with
 * `pnpm --filter @montaj/web exec tsx --test e2e/env.test.ts` (see
 * `e2e/README.md`). Named `*.test.ts` rather than `*.spec.ts` so Playwright's
 * default `testMatch` (`playwright.config.ts` sets none, so it applies) never
 * picks it up as a spec.
 *
 * Covers the addendum fix: `redisKeyPrefix` (`env.ts`) has to derive the
 * fixtures' Redis namespace from `MONTAJ_REDIS_PREFIX` the same way the API's
 * own `redisKeyPrefix()` (`apps/api/src/common/redis/redis-keys.ts`) does, or
 * a worktree with a non-default prefix reads a key the API never wrote to and
 * every sign-up fixture times out waiting for a message that already arrived.
 */
void describe("redisKeyPrefix", () => {
  void it("defaults to montaj when MONTAJ_REDIS_PREFIX is unset", () => {
    assert.equal(redisKeyPrefix({}), "montaj");
  });

  void it("defaults to montaj when MONTAJ_REDIS_PREFIX is blank", () => {
    assert.equal(redisKeyPrefix({ MONTAJ_REDIS_PREFIX: "" }), "montaj");
    assert.equal(redisKeyPrefix({ MONTAJ_REDIS_PREFIX: "   " }), "montaj");
  });

  void it("uses the worktree's prefix when set, matching the API's redisKeyPrefix()", () => {
    assert.equal(redisKeyPrefix({ MONTAJ_REDIS_PREFIX: "a23" }), "a23");
  });

  void it("trims surrounding whitespace", () => {
    assert.equal(redisKeyPrefix({ MONTAJ_REDIS_PREFIX: "  b08  " }), "b08");
  });
});

void describe("parseEnv", () => {
  void it("reads MONTAJ_REDIS_PREFIX from a parsed .env file", () => {
    const parsed = parseEnv("DATABASE_URL=postgresql://x\nMONTAJ_REDIS_PREFIX=a23\n");
    assert.equal(redisKeyPrefix(parsed), "a23");
  });
});
