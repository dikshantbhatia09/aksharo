import { describe, expect, it } from "vitest";

import {
  DEFAULT_DUB_DAILY_BUDGET_INR,
  DubBudget,
  dubDailyBudgetPaise,
  utcDay,
} from "./dub-budget.js";
import { DUB_ERRORS } from "./dubs.constants.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { RedisService } from "../../common/redis/redis.service.js";

const NOW = Date.parse("2026-10-04T10:00:00Z");

/**
 * Just enough of ioredis: the reserve script's effect (read, compare, add,
 * expire) run the way Redis runs a script, whole, and DECRBY. The script itself
 * is exercised against a real Redis in `test/dub-budget.e2e-spec.ts`.
 */
function fakeRedis(options: { broken?: boolean } = {}) {
  const values = new Map<string, number>();
  const expiries = new Map<string, number>();
  const fail = (): void => {
    if (options.broken === true) throw new Error("ECONNREFUSED");
  };
  const client = {
    status: "ready",
    connect: async () => undefined,
    eval: async (
      _script: string,
      _keys: number,
      key: string,
      want: number,
      cap: number,
      ttl: number,
    ) => {
      fail();
      const spent = values.get(key) ?? 0;
      if (spent + Number(want) > Number(cap)) return [0, spent];
      values.set(key, spent + Number(want));
      expiries.set(key, Number(ttl));
      return [1, spent + Number(want)];
    },
    decrby: async (key: string, amount: number) => {
      fail();
      values.set(key, (values.get(key) ?? 0) - amount);
      return values.get(key);
    },
  };
  return { redis: { client } as unknown as RedisService, values, expiries };
}

function budget(capPaise: number, options: { broken?: boolean } = {}) {
  const fake = fakeRedis(options);
  const service = new DubBudget(fake.redis);
  service.capPaise = () => capPaise;
  return { service, ...fake };
}

describe("DubBudget (2026-10-04)", () => {
  it("charges a request that fits, on today's key, and refuses one that does not", async () => {
    const { service, values, expiries } = budget(10_000);
    expect(await service.reserve(6_000, NOW)).toEqual({
      ok: true,
      day: "2026-10-04",
      spentPaise: 6_000,
    });
    expect(await service.reserve(5_000, NOW)).toEqual({
      ok: false,
      day: "2026-10-04",
      spentPaise: 6_000,
      capPaise: 10_000,
    });
    expect(await service.reserve(4_000, NOW)).toMatchObject({ ok: true, spentPaise: 10_000 });
    const [key] = [...values.keys()];
    expect(key).toMatch(/:dub:spend:v1:2026-10-04$/);
    expect(expiries.get(key ?? "")).toBe(3 * 24 * 60 * 60);
  });

  it("gives back what was never spent, to the day it was charged on", async () => {
    const { service, values } = budget(10_000);
    await service.reserve(6_000, NOW);
    // Released the next morning: yesterday's tally, not today's.
    await service.release("2026-10-04", 6_000);
    expect([...values.values()]).toEqual([0]);
    expect(await service.reserve(10_000, NOW)).toMatchObject({ ok: true });
  });

  it("refuses rather than trusts when Redis cannot say", async () => {
    const { service } = budget(10_000, { broken: true });
    const refused = await service.reserve(100, NOW).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppException);
    expect((refused as AppException).code).toBe(DUB_ERRORS.budgetUnavailable);
    // A give-back that cannot reach Redis leaves the day over-counted, silently.
    await expect(service.release("2026-10-04", 100)).resolves.toBeUndefined();
  });

  it("reads the cap from DUB_DAILY_BUDGET_INR, in paise, ₹500 by default", () => {
    expect(dubDailyBudgetPaise({})).toBe(DEFAULT_DUB_DAILY_BUDGET_INR * 100);
    expect(dubDailyBudgetPaise({ DUB_DAILY_BUDGET_INR: "120.5" })).toBe(12_050);
    expect(dubDailyBudgetPaise({ DUB_DAILY_BUDGET_INR: "0" })).toBe(0);
    expect(dubDailyBudgetPaise({ DUB_DAILY_BUDGET_INR: "lots" })).toBe(50_000);
    expect(utcDay(Date.parse("2026-10-04T23:59:59+05:30"))).toBe("2026-10-04");
  });

  it("refuses everything when the cap is nought", async () => {
    const { service } = budget(0);
    expect(await service.reserve(1, NOW)).toMatchObject({ ok: false });
  });
});
