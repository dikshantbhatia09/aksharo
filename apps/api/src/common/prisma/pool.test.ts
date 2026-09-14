import { describe, expect, it } from "vitest";

import { applyPoolBudget, DEFAULT_POOL_SIZE, DEFAULT_POOL_TIMEOUT_SEC } from "./pool.js";

const BASE = "postgresql://montaj:montaj@db:5432/montaj_main?schema=public";

function limitOf(url: string): string | null {
  return new URL(url).searchParams.get("connection_limit");
}

describe("applyPoolBudget", () => {
  /**
   * Prisma's own default is `numCpus * 2 + 1`, so the fleet's total connection
   * use depends on the node size rather than the replica count — and is only
   * discovered when the database runs out (P0-11).
   */
  it("states a limit rather than letting Prisma infer one from the host", () => {
    const { url, budget } = applyPoolBudget(BASE, {});
    expect(limitOf(url)).toBe(String(DEFAULT_POOL_SIZE));
    expect(budget.connectionLimit).toBe(DEFAULT_POOL_SIZE);
    expect(budget.fromUrl).toBe(false);
  });

  it("takes the operator's per-process budget", () => {
    const { url, budget } = applyPoolBudget(BASE, { DATABASE_POOL_SIZE: "4" });
    expect(limitOf(url)).toBe("4");
    expect(budget.connectionLimit).toBe(4);
  });

  it("bounds the wait for a free connection so a saturated pool fails fast", () => {
    const { url } = applyPoolBudget(BASE, {});
    expect(new URL(url).searchParams.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SEC));

    const tuned = applyPoolBudget(BASE, { DATABASE_POOL_TIMEOUT_SEC: "3" });
    expect(new URL(tuned.url).searchParams.get("pool_timeout")).toBe("3");
  });

  /**
   * An operator who tuned the URL by hand made the more specific statement.
   * Overriding it would put the effective limit in neither place.
   */
  it("leaves a limit already in the URL alone", () => {
    const explicit = `${BASE}&connection_limit=25`;
    const { url, budget } = applyPoolBudget(explicit, { DATABASE_POOL_SIZE: "4" });
    expect(url).toBe(explicit);
    expect(budget.connectionLimit).toBe(25);
    expect(budget.fromUrl).toBe(true);
  });

  it("ignores a nonsensical budget rather than opening zero connections", () => {
    for (const value of ["0", "-3", "lots", ""]) {
      expect(
        limitOf(applyPoolBudget(BASE, { DATABASE_POOL_SIZE: value }).url),
        `DATABASE_POOL_SIZE=${value}`,
      ).toBe(String(DEFAULT_POOL_SIZE));
    }
  });

  it("keeps the rest of the connection string intact", () => {
    const parsed = new URL(applyPoolBudget(BASE, {}).url);
    expect(parsed.searchParams.get("schema")).toBe("public");
    expect(parsed.username).toBe("montaj");
    expect(parsed.pathname).toBe("/montaj_main");
  });

  it("hands an unparseable URL back untouched for Prisma to complain about", () => {
    const { url } = applyPoolBudget("not a url", {});
    expect(url).toBe("not a url");
  });
});
