/**
 * The error envelope of CONTRACTS §8, end to end.
 *
 * Two paths, because they fail in different layers: a route the router never
 * matched, and a body the validation pipe rejected. Both have to come back as
 * `{ error: { code, message, details?, requestId } }` with a `namespace/slug`
 * code — that shape is what `packages/api-client` is generated against.
 */
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestApp } from "./app-harness.js";
import { AppException, ERROR_CODE_PATTERN, ERROR_CODES } from "../src/common/errors/error-codes.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { requestContextMiddleware } from "../src/common/logging/logging.module.js";
import { REQUEST_ID_HEADER } from "../src/common/request-context.js";
import { zodDto, ZodValidationPipe } from "../src/common/validation/zod-validation.pipe.js";

import type { INestApplication, MiddlewareConsumer, NestModule } from "@nestjs/common";

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

// --- A throwaway module exercising the pipe and a domain exception ----------

const CreateThing = z.object({ title: z.string().min(1), count: z.number().int().positive() });
class CreateThingDto extends zodDto(CreateThing) {}

@Controller("things")
class ThingsController {
  @Post()
  create(@Body() body: CreateThingDto): CreateThingDto {
    return body;
  }

  @Get("upgrade")
  upgrade(): never {
    throw new AppException(
      ERROR_CODES.entitlementUpgradeRequired,
      "Creator or above is required for this operation.",
      402,
      { requiredPlan: "creator" },
    );
  }

  @Get("boom")
  boom(): never {
    throw new Error("internal detail: DATABASE_URL=postgres://u:p@h/db");
  }
}

@Module({
  controllers: [ThingsController],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
class ThingsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes("*path");
  }
}

describe("error envelope (e2e)", () => {
  let app: INestApplication;
  let realApp: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ThingsModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    realApp = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await realApp?.close();
  });

  it("wraps an unknown route on the real application", async () => {
    const response = await request(realApp.getHttpServer())
      .get("/definitely-not-a-route")
      .expect(404);

    const body = response.body as Envelope;
    expect(body.error.code).toBe(ERROR_CODES.notFound);
    expect(body.error.code).toMatch(ERROR_CODE_PATTERN);
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it("wraps a validation failure, with one issue per bad field", async () => {
    const response = await request(app.getHttpServer())
      .post("/things")
      .send({ title: "", count: -1 })
      .expect(400);

    const body = response.body as Envelope;
    expect(body.error.code).toBe(ERROR_CODES.validationFailed);
    const details = body.error.details as { issues: { path: string }[] };
    expect(details.issues.map((issue) => issue.path).sort()).toEqual(["count", "title"]);
  });

  it("accepts a valid body and returns the parsed value", async () => {
    const response = await request(app.getHttpServer())
      .post("/things")
      .send({ title: "Reel", count: 3, extra: "dropped" })
      .expect(201);

    expect(response.body).toEqual({ title: "Reel", count: 3 });
  });

  it("carries a domain code and its machine-readable details", async () => {
    const response = await request(app.getHttpServer()).get("/things/upgrade").expect(402);
    const body = response.body as Envelope;
    expect(body.error.code).toBe("entitlement/upgrade_required");
    expect(body.error.details).toEqual({ requiredPlan: "creator" });
  });

  it("never leaks the internals of an unexpected failure", async () => {
    const response = await request(app.getHttpServer()).get("/things/boom").expect(500);
    const body = response.body as Envelope;
    expect(body.error.code).toBe(ERROR_CODES.internal);
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });

  it("echoes the request id on the response and reuses an inbound one", async () => {
    const inbound = "01JQ0000000000000000000099";
    const response = await request(app.getHttpServer())
      .get("/things/upgrade")
      .set(REQUEST_ID_HEADER, inbound)
      .expect(402);

    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    expect(response.headers[REQUEST_ID_HEADER]).toBe(inbound);
    expect((response.body as Envelope).error.requestId).toBe(inbound);
  });

  it("mints a request id when the caller supplies a malformed one", async () => {
    const response = await request(app.getHttpServer())
      .get("/things/upgrade")
      .set(REQUEST_ID_HEADER, "not a valid id")
      .expect(402);

    const body = response.body as Envelope;
    expect(body.error.requestId).not.toBe("not a valid id");
    expect(body.error.requestId).toHaveLength(26);
  });
});
