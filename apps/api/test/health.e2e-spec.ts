import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp } from "./app-harness.js";
import { APP_VERSION } from "../src/version.js";

import type { INestApplication } from "@nestjs/common";

describe("API (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /health returns ok and the version", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    expect(response.body).toEqual({ status: "ok", version: APP_VERSION });
  });

  it("GET /health/ready reports db, redis and storage", async () => {
    const response = await request(app.getHttpServer()).get("/health/ready");

    // The storage check dials a real endpoint, so it may be up or down here; the
    // contract under test is the shape, and that db and redis are reported.
    expect([200, 503]).toContain(response.status);
    const body = response.body as {
      status: string;
      version: string;
      checks: Record<string, { status: string; latencyMs: number }>;
    };
    expect(body.version).toBe(APP_VERSION);
    expect(Object.keys(body.checks).sort()).toEqual(["db", "redis", "storage"]);
    expect(body.checks["db"]?.status).toBe("up");
    expect(body.checks["redis"]?.status).toBe("up");
    expect(typeof body.checks["db"]?.latencyMs).toBe("number");
  });

  it("GET /docs serves the OpenAPI UI", async () => {
    const response = await request(app.getHttpServer()).get("/docs").expect(200);
    expect(response.text).toContain("swagger");
  });

  it("GET /docs-json describes /health and /health/ready", async () => {
    const response = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const document = response.body as {
      info: { version: string };
      paths: Record<string, unknown>;
    };
    expect(document.info.version).toBe(APP_VERSION);
    expect(Object.keys(document.paths)).toContain("/health");
    expect(Object.keys(document.paths)).toContain("/health/ready");
  });
});

describe("readiness with a dependency down (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      redisPing: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("answers 503 so a load balancer drains the instance", async () => {
    const response = await request(app.getHttpServer()).get("/health/ready").expect(503);
    const body = response.body as { status: string; checks: Record<string, { status: string }> };
    expect(body.status).toBe("degraded");
    expect(body.checks["redis"]?.status).toBe("down");
    expect(body.checks["db"]?.status).toBe("up");
  });
});
