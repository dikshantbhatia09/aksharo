import { describe, expect, it, vi } from "vitest";

import { APP_VERSION } from "../version.js";
import { HealthController } from "./health.controller.js";

import type { ReadinessReport, HealthService } from "./health.service.js";
import type { Response } from "express";

function fakeResponse(): Response & { statusCode: number } {
  const response = {
    statusCode: 0,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
  };
  return response as unknown as Response & { statusCode: number };
}

function controllerWith(report: ReadinessReport): HealthController {
  return new HealthController({
    readiness: vi.fn().mockResolvedValue(report),
  } as unknown as HealthService);
}

const up = { status: "up", latencyMs: 1 } as const;
const down = { status: "down", latencyMs: 2, error: "ECONNREFUSED" } as const;

describe("HealthController", () => {
  it("reports ok and the deployed version on the liveness probe", () => {
    const controller = controllerWith({ status: "ok", checks: { db: up, redis: up, storage: up } });
    expect(controller.getHealth()).toEqual({ status: "ok", version: APP_VERSION });
  });

  it("answers 200 when every dependency is up", async () => {
    const controller = controllerWith({ status: "ok", checks: { db: up, redis: up, storage: up } });
    const response = fakeResponse();

    const body = await controller.getReadiness(response);

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(APP_VERSION);
    expect(body.checks.db.status).toBe("up");
  });

  it("answers 503 but still reports every check when one is down", async () => {
    const controller = controllerWith({
      status: "degraded",
      checks: { db: up, redis: down, storage: up },
    });
    const response = fakeResponse();

    const body = await controller.getReadiness(response);

    // A load balancer drains the instance, and an operator still learns that
    // Postgres is healthy and Redis is not.
    expect(response.statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.db.status).toBe("up");
    expect(body.checks.redis.status).toBe("down");
  });
});
