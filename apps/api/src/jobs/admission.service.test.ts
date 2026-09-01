import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";

import { AdmissionService } from "./admission.service.js";
import { PLAN_CONCURRENCY_LANE, PLAN_ENQUEUED_CAP_TENTHS } from "./jobs.config.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";
import { AppException } from "../common/errors/error-codes.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

const WS = "01JCWS0000000000000000000A";

let db: FakeDb;
let admission: AdmissionService;

beforeEach(() => {
  db = new FakeDb();
  admission = new AdmissionService(createFakePrisma(db) as unknown as PrismaService);
});

describe("admit", () => {
  it("returns the plan's limits and the current occupancy", async () => {
    db.plans.set(WS, "creator");
    db.job({ workspaceId: WS, status: "running", creditsChargedTenths: 120 });
    db.job({ workspaceId: WS, status: "queued", creditsChargedTenths: 80 });

    const decision = await admission.admit({ workspaceId: WS, worstCaseTenths: 10 });

    expect(decision.limits.plan).toBe("creator");
    expect(decision.inFlightJobs).toBe(2);
    expect(decision.inFlightTenths).toBe(200);
  });

  it("treats a workspace with no live subscription as free", async () => {
    const decision = await admission.admit({ workspaceId: WS, worstCaseTenths: 1 });
    expect(decision.limits.plan).toBe("free");
  });

  it("ignores finished jobs and other workspaces", async () => {
    db.plans.set(WS, "creator");
    db.job({ workspaceId: WS, status: "succeeded", creditsChargedTenths: 1_000 });
    db.job({ workspaceId: WS, status: "failed", creditsChargedTenths: 1_000 });
    db.job({ workspaceId: WS, status: "cancelled", creditsChargedTenths: 1_000 });
    db.job({
      workspaceId: "01JCWS0000000000000000000B",
      status: "queued",
      creditsChargedTenths: 1_000,
    });

    const decision = await admission.admit({ workspaceId: WS, worstCaseTenths: 10 });
    expect(decision.inFlightJobs).toBe(0);
    expect(decision.inFlightTenths).toBe(0);
  });

  it("refuses when the enqueued-credit cap would be crossed (T23)", async () => {
    db.plans.set(WS, "creator");
    db.job({
      workspaceId: WS,
      status: "queued",
      creditsChargedTenths: PLAN_ENQUEUED_CAP_TENTHS.creator - 5,
    });

    const failure = await admission
      .admit({ workspaceId: WS, worstCaseTenths: 10 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppException);
    const error = failure as AppException;
    expect(error.code).toBe("jobs/enqueue_cap");
    expect(error.httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.details).toMatchObject({
      plan: "creator",
      requestedTenths: 10,
      enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS.creator,
    });
  });

  it("admits a job that lands exactly on the cap", async () => {
    db.plans.set(WS, "creator");
    db.job({
      workspaceId: WS,
      status: "queued",
      creditsChargedTenths: PLAN_ENQUEUED_CAP_TENTHS.creator - 10,
    });
    await expect(admission.admit({ workspaceId: WS, worstCaseTenths: 10 })).resolves.toBeDefined();
  });

  it("refuses when the concurrency lane is full", async () => {
    db.plans.set(WS, "starter");
    for (let index = 0; index < PLAN_CONCURRENCY_LANE.starter; index += 1) {
      db.job({ workspaceId: WS, status: "queued", creditsChargedTenths: 1 });
    }

    const failure = await admission
      .admit({ workspaceId: WS, worstCaseTenths: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppException);
    expect((failure as AppException).code).toBe("jobs/concurrency_cap");
    expect((failure as AppException).details).toMatchObject({
      concurrencyLane: PLAN_CONCURRENCY_LANE.starter,
    });
  });

  it("checks the lane before the credit cap, so the cheaper answer wins", async () => {
    db.plans.set(WS, "free");
    for (let index = 0; index < PLAN_CONCURRENCY_LANE.free; index += 1) {
      db.job({
        workspaceId: WS,
        status: "queued",
        creditsChargedTenths: PLAN_ENQUEUED_CAP_TENTHS.free,
      });
    }
    const failure = await admission
      .admit({ workspaceId: WS, worstCaseTenths: 10 })
      .catch((error: unknown) => error);
    expect((failure as AppException).code).toBe("jobs/concurrency_cap");
  });
});
