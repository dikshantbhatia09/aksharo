import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.js";
import { setupOpenApi } from "../src/openapi.js";
import { APP_VERSION } from "../src/version.js";

import type { INestApplication } from "@nestjs/common";

describe("API (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupOpenApi(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /health returns ok and the version", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    expect(response.body).toEqual({ status: "ok", version: APP_VERSION });
  });

  it("GET /docs serves the OpenAPI UI", async () => {
    const response = await request(app.getHttpServer()).get("/docs").expect(200);
    expect(response.text).toContain("swagger");
  });

  it("GET /docs-json describes /health", async () => {
    const response = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const document = response.body as {
      info: { version: string };
      paths: Record<string, unknown>;
    };
    expect(document.info.version).toBe(APP_VERSION);
    expect(Object.keys(document.paths)).toContain("/health");
  });

  it("returns 404 for an unknown route", async () => {
    await request(app.getHttpServer()).get("/definitely-not-a-route").expect(404);
  });
});
