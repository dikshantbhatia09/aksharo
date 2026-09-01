import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";

import { CreditsInsufficientError } from "./credits.facade.js";
import { FREE_TIER_DAILY_TENTHS, NoopCreditsFacade } from "./noop-credits.facade.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";
import { FREE_TIER_DAILY_MINUTES } from "../jobs/jobs.config.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

const WORKSPACE = "01JCWS0000000000000000000A";

let db: FakeDb;
let credits: NoopCreditsFacade;

beforeEach(() => {
  db = new FakeDb();
  credits = new NoopCreditsFacade(createFakePrisma(db) as unknown as PrismaService);
});

describe("reserve", () => {
  it("returns a hold id", async () => {
    db.plans.set(WORKSPACE, "creator");
    const { holdId } = await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "job-1",
      worstCaseTenths: 100,
      reason: "test",
    });
    expect(holdId).toHaveLength(26);
    expect(credits.holdStatus(holdId)).toBe("held");
  });

  it("rejects a non-integer or negative amount", async () => {
    db.plans.set(WORKSPACE, "creator");
    for (const worstCaseTenths of [1.5, -1, Number.NaN]) {
      await expect(
        credits.reserve({ workspaceId: WORKSPACE, jobId: "j", worstCaseTenths, reason: "r" }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("free-tier daily cap (THREAT-MODEL T23)", () => {
  it("allows the whole allowance", async () => {
    await expect(
      credits.reserve({
        workspaceId: WORKSPACE,
        jobId: "j",
        worstCaseTenths: FREE_TIER_DAILY_TENTHS,
        reason: "r",
      }),
    ).resolves.toMatchObject({ holdId: expect.any(String) });
  });

  it("refuses the job that would cross it, with the shortfall", async () => {
    await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j1",
      worstCaseTenths: FREE_TIER_DAILY_TENTHS - 10,
      reason: "r",
    });

    const failure = await credits
      .reserve({ workspaceId: WORKSPACE, jobId: "j2", worstCaseTenths: 50, reason: "r" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CreditsInsufficientError);
    const error = failure as CreditsInsufficientError;
    expect(error.httpStatus).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(error.code).toBe("credits/insufficient");
    expect(error.shortfallTenths).toBe(40);
    expect(error.details).toMatchObject({ plan: "free", usedTenths: FREE_TIER_DAILY_TENTHS - 10 });
    expect(error.message).toContain(String(FREE_TIER_DAILY_MINUTES));
  });

  it("does not apply to a paid plan", async () => {
    db.plans.set(WORKSPACE, "studio");
    for (let index = 0; index < 5; index += 1) {
      await expect(
        credits.reserve({
          workspaceId: WORKSPACE,
          jobId: `j${String(index)}`,
          worstCaseTenths: FREE_TIER_DAILY_TENTHS,
          reason: "r",
        }),
      ).resolves.toBeDefined();
    }
  });

  it("gives the allowance back when a hold is released", async () => {
    const { holdId } = await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j1",
      worstCaseTenths: FREE_TIER_DAILY_TENTHS,
      reason: "r",
    });
    await expect(
      credits.reserve({ workspaceId: WORKSPACE, jobId: "j2", worstCaseTenths: 10, reason: "r" }),
    ).rejects.toBeInstanceOf(CreditsInsufficientError);

    await credits.release({ holdId });

    await expect(
      credits.reserve({ workspaceId: WORKSPACE, jobId: "j2", worstCaseTenths: 10, reason: "r" }),
    ).resolves.toBeDefined();
  });

  it("counts each workspace separately", async () => {
    await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j1",
      worstCaseTenths: FREE_TIER_DAILY_TENTHS,
      reason: "r",
    });
    await expect(
      credits.reserve({
        workspaceId: "01JCWS0000000000000000000B",
        jobId: "j2",
        worstCaseTenths: FREE_TIER_DAILY_TENTHS,
        reason: "r",
      }),
    ).resolves.toBeDefined();
  });
});

describe("settle (THREAT-MODEL T8: a replay must not charge twice)", () => {
  it("records the settlement once and is idempotent afterwards", async () => {
    db.plans.set(WORKSPACE, "creator");
    const { holdId } = await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j",
      worstCaseTenths: 100,
      reason: "r",
    });

    await expect(credits.settle({ holdId, actualTenths: 40 })).resolves.toEqual({
      settledTenths: 40,
    });
    expect(credits.holdStatus(holdId)).toBe("settled");

    // The replay reports what was actually settled, not the amount it was told.
    await expect(credits.settle({ holdId, actualTenths: 999 })).resolves.toEqual({
      settledTenths: 40,
    });
  });

  it("treats an unknown hold as a no-op rather than an error", async () => {
    await expect(credits.settle({ holdId: "nope", actualTenths: 7 })).resolves.toEqual({
      settledTenths: 7,
    });
  });

  it("refuses a non-integer amount", async () => {
    await expect(credits.settle({ holdId: "x", actualTenths: -3 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("release", () => {
  it("is idempotent and never reopens a settled hold", async () => {
    db.plans.set(WORKSPACE, "creator");
    const { holdId } = await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j",
      worstCaseTenths: 10,
      reason: "r",
    });
    await credits.release({ holdId });
    expect(credits.holdStatus(holdId)).toBe("released");
    await credits.release({ holdId });
    expect(credits.holdStatus(holdId)).toBe("released");

    await credits.settle({ holdId, actualTenths: 10 });
    expect(credits.holdStatus(holdId)).toBe("released");
  });

  it("ignores an unknown hold", async () => {
    await expect(credits.release({ holdId: "nope" })).resolves.toBeUndefined();
  });
});

describe("grantLot", () => {
  it("returns a lot id so Wave 3 producers can be written now", async () => {
    const { lotId } = await credits.grantLot({
      workspaceId: WORKSPACE,
      source: "topup",
      tenths: 500,
      reason: "invoice",
    });
    expect(lotId).toHaveLength(26);
  });

  it("validates the amount", async () => {
    await expect(
      credits.grantLot({ workspaceId: WORKSPACE, source: "grant", tenths: -1, reason: "r" }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("reset", () => {
  it("drops every hold and allowance", async () => {
    const { holdId } = await credits.reserve({
      workspaceId: WORKSPACE,
      jobId: "j",
      worstCaseTenths: FREE_TIER_DAILY_TENTHS,
      reason: "r",
    });
    credits.reset();
    expect(credits.holdStatus(holdId)).toBeUndefined();
    await expect(
      credits.reserve({
        workspaceId: WORKSPACE,
        jobId: "j2",
        worstCaseTenths: FREE_TIER_DAILY_TENTHS,
        reason: "r",
      }),
    ).resolves.toBeDefined();
  });
});
