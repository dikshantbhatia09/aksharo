import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostizClient } from "./postiz/postiz.client.js";
import { PublishWorker } from "./publish-worker.js";
import { PUBLISHING_PROVIDERS } from "./publishing.module.js";
import { PublishingService } from "./publishing.service.js";
import { createFakeRedis } from "../../test/fakes.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { RedisService } from "../common/redis/redis.service.js";
import { DERIVED_STORE } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { QueueRegistry } from "../jobs/queue.registry.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

/**
 * The module's own provider list, resolved by Nest's injector with the global
 * and imported providers stubbed: a constructor parameter imported with
 * `import type`, or a token nobody provides, fails here rather than at boot.
 */
describe("PublishingModule providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolve, and stay idle without a Postiz key", async () => {
    vi.stubEnv("POSTIZ_API_KEY", "");
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...PUBLISHING_PROVIDERS,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: createFakeRedis() },
        { provide: QueueRegistry, useValue: { prefix: "bull" } },
        { provide: EntitlementService, useValue: {} },
        { provide: CommonAuditService, useValue: {} },
        { provide: DERIVED_STORE, useValue: {} },
        { provide: ENV, useValue: { FEATURE_FLAGS_JSON: {} } },
      ],
    }).compile();
    // Bootstrap runs the worker's start-up: without a key it must not open a Worker.
    await moduleRef.init();

    expect(moduleRef.get(PublishingService)).toBeInstanceOf(PublishingService);
    expect(moduleRef.get(PublishWorker)).toBeInstanceOf(PublishWorker);
    expect(moduleRef.get(PostizClient).configured).toBe(false);

    await moduleRef.close();
  });
});
