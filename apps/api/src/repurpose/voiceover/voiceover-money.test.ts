import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICEOVER_DAILY_BUDGET_INR,
  VoiceoverBudget,
  voiceoverDailyBudgetPaise,
} from "./voiceover-budget.js";
import { voiceoverLanguageOf } from "./voiceover-languages.js";
import { VOICEOVER_TENTHS, voiceoverVendorPaise } from "./voiceover-pricing.js";
import { VOICEOVER_ERRORS } from "./voiceover.constants.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { RedisService } from "../../common/redis/redis.service.js";

const NOW = Date.parse("2026-10-01T10:00:00Z");

/** Just enough of ioredis for the reserve script's effect, run whole, and DECRBY. */
function fakeRedis(options: { broken?: boolean } = {}) {
  const values = new Map<string, number>();
  const client = {
    status: "ready",
    connect: async () => undefined,
    eval: async (_s: string, _k: number, key: string, want: number, cap: number) => {
      if (options.broken === true) throw new Error("ECONNREFUSED");
      const spent = values.get(key) ?? 0;
      if (spent + Number(want) > Number(cap)) return [0, spent];
      values.set(key, spent + Number(want));
      return [1, spent + Number(want)];
    },
    decrby: async (key: string, amount: number) => {
      values.set(key, (values.get(key) ?? 0) - amount);
      return values.get(key);
    },
  };
  return { redis: { client } as unknown as RedisService, values };
}

describe("voice-over pricing (2026-10-01)", () => {
  it("is a flat 2 credits, and the vendor's ₹30 per 10,000 characters rounded up", () => {
    expect(VOICEOVER_TENTHS).toBe(20);
    expect(voiceoverVendorPaise(46)).toBe(14);
    expect(voiceoverVendorPaise(300)).toBe(90);
    expect(voiceoverVendorPaise(0)).toBe(0);
    expect(voiceoverVendorPaise(Number.NaN)).toBe(0);
  });
});

describe("VoiceoverBudget", () => {
  it("charges the day atomically and refuses past the cap", async () => {
    const fake = fakeRedis();
    const budget = new VoiceoverBudget(fake.redis);
    budget.capPaise = () => 100;
    expect(await budget.reserve(60, NOW)).toEqual({ ok: true, day: "2026-10-01" });
    expect(await budget.reserve(60, NOW)).toEqual({ ok: false, day: "2026-10-01", spentPaise: 60 });
    expect([...fake.values.keys()][0]).toMatch(/:voiceover:spend:v1:2026-10-01$/u);
    await budget.release("2026-10-01", 60);
    expect(await budget.reserve(60, NOW)).toMatchObject({ ok: true });
  });

  it("refuses rather than trusts when Redis cannot say", async () => {
    const budget = new VoiceoverBudget(fakeRedis({ broken: true }).redis);
    const error = await budget.reserve(10, NOW).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(VOICEOVER_ERRORS.budgetUnavailable);
  });

  it("reads its cap from VOICEOVER_DAILY_BUDGET_INR, ₹100 by default", () => {
    expect(voiceoverDailyBudgetPaise({})).toBe(DEFAULT_VOICEOVER_DAILY_BUDGET_INR * 100);
    expect(voiceoverDailyBudgetPaise({ VOICEOVER_DAILY_BUDGET_INR: "25" })).toBe(2_500);
    expect(voiceoverDailyBudgetPaise({ VOICEOVER_DAILY_BUDGET_INR: "0" })).toBe(0);
    expect(voiceoverDailyBudgetPaise({ VOICEOVER_DAILY_BUDGET_INR: "lots" })).toBe(10_000);
  });
});

describe("voiceoverLanguageOf", () => {
  it("speaks the clip's language as the speech API spells it", () => {
    expect(voiceoverLanguageOf("en")).toBe("en-IN");
    expect(voiceoverLanguageOf("hi-Latn")).toBe("hi-IN");
    expect(voiceoverLanguageOf("or")).toBe("od-IN");
    expect(voiceoverLanguageOf("od")).toBe("od-IN");
    expect(voiceoverLanguageOf("as")).toBeNull();
    expect(voiceoverLanguageOf("auto")).toBeNull();
    expect(voiceoverLanguageOf(null)).toBeNull();
  });
});
