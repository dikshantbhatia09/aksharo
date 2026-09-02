/**
 * The notify HTTP surface, over a real HTTP server with fake infrastructure.
 *
 * The one thing only an end-to-end test can prove here is the body: Amazon SNS
 * posts `Content-Type: text/plain`, Nest's JSON parser skips it, and the route
 * would see `{}` were it not for `SnsBodyMiddleware`. A unit test on the
 * controller cannot catch that, because it is handed an object either way — so
 * the suppression path is driven through supertest with the header SNS really
 * sends.
 *
 * `/me/notifications` is covered by its unit suite (`src/notify/notify.controller.test.ts`);
 * here it only has to answer 401 without a token, which is what proves the guard
 * is actually attached to the shipped controller.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp } from "./app-harness.js";
import { createMemoryRedis } from "./fakes.js";
import { snsFixture, snsNotification } from "./sns-fixture.js";
import { notifyRedisKeys } from "../src/notify/notify.constants.js";
import { CERTIFICATE_FETCHER } from "../src/notify/sns/mail-events.controller.js";
import { MAX_SNS_BODY_BYTES } from "../src/notify/sns/sns-body.middleware.js";
import { SuppressionService } from "../src/notify/suppression.service.js";

import type { MemoryRedis } from "./fakes.js";
import type { INestApplication } from "@nestjs/common";

let app: INestApplication;
let redis: MemoryRedis;
const auditRows: Record<string, unknown>[] = [];

beforeAll(async () => {
  redis = createMemoryRedis();
  app = await createTestApp({
    redisClient: redis,
    prisma: {
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          auditRows.push(data);
          return data;
        },
      },
    },
    overrides: [[CERTIFICATE_FETCHER, async () => snsFixture.certificate]],
  });
});

afterAll(async () => {
  await app?.close();
});

const server = () => app.getHttpServer();

describe("POST /internal/mail/events", () => {
  it.runIf(snsFixture.available)(
    "reads the text/plain body SNS actually sends and suppresses the bounce",
    async () => {
      const body = snsFixture.sign(
        snsNotification({
          notificationType: "Bounce",
          bounce: {
            bounceType: "Permanent",
            bounceSubType: "General",
            bouncedRecipients: [{ emailAddress: "gone@example.test" }],
          },
        }),
      );

      const response = await request(server())
        .post("/internal/mail/events")
        // Exactly what SNS sets, and what the global JSON parser refuses.
        .set("Content-Type", "text/plain; charset=UTF-8")
        .send(JSON.stringify(body))
        .expect(200);

      expect(response.body).toEqual({
        status: "ok",
        handled: "bounce",
        suppressed: 1,
        released: 0,
      });
      expect(
        redis.store.has(notifyRedisKeys.suppression(SuppressionService.hash("gone@example.test"))),
      ).toBe(true);
      expect(auditRows.at(-1)).toMatchObject({
        action: "notify.address.suppressed",
        resource: "email",
        actorKind: "system",
      });
    },
  );

  it.runIf(snsFixture.available)("also accepts a correct application/json body", async () => {
    const body = snsFixture.sign(
      snsNotification({
        notificationType: "Complaint",
        complaint: {
          complainedRecipients: [{ emailAddress: "cross@example.test" }],
          complaintFeedbackType: "abuse",
        },
      }),
    );

    await request(server()).post("/internal/mail/events").send(body).expect(200);
    expect(
      redis.store.has(notifyRedisKeys.suppression(SuppressionService.hash("cross@example.test"))),
    ).toBe(true);
  });

  it("answers the error envelope for a body that is not an SNS message", async () => {
    const response = await request(server())
      .post("/internal/mail/events")
      .set("Content-Type", "text/plain; charset=UTF-8")
      .send("this is not json")
      .expect(400);

    expect(response.body.error.code).toBe("common/bad_request");
    expect(response.body.error.requestId).toBeTruthy();
  });

  it("refuses to buffer an oversized body on an unauthenticated route", async () => {
    await request(server())
      .post("/internal/mail/events")
      .set("Content-Type", "text/plain; charset=UTF-8")
      .send("x".repeat(MAX_SNS_BODY_BYTES + 1024))
      .catch(() => undefined);
    // The connection is destroyed rather than answered; the assertion that
    // matters is that the process is still serving afterwards.
    await request(server()).get("/health").expect(200);
  });
});

describe("GET /me/notifications", () => {
  it("is behind the access-token guard", async () => {
    const response = await request(server()).get("/me/notifications").expect(401);
    expect(response.body.error.code).toBe("common/unauthorized");
  });

  it("refuses to mark one read without a token either", async () => {
    await request(server()).post("/me/notifications/01JCN0000000000000000000A/read").expect(401);
  });
});

describe("the OpenAPI document", () => {
  it("publishes the two bell routes and hides the internal webhook", async () => {
    const response = await request(server()).get("/docs-json").expect(200);
    const paths = Object.keys(response.body.paths as Record<string, unknown>);
    expect(paths).toContain("/me/notifications");
    expect(paths).toContain("/me/notifications/{id}/read");
    expect(paths).not.toContain("/internal/mail/events");
  });
});
