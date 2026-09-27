import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertSender } from "./alert-sender.js";
import { OPS_WATCH_PROVIDERS } from "./ops-watch.module.js";
import { OpsWatchTask } from "./ops-watch.task.js";
import { createFakeRedis } from "../../../test/fakes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { LeaseReaperTask } from "../../jobs/lease-reaper.task.js";
import { QueueRegistry } from "../../jobs/queue.registry.js";

/**
 * The module's own provider list, resolved by Nest's injector with the global
 * and `JobsModule` providers stubbed: a constructor parameter imported with
 * `import type`, or a token nobody provides, fails here rather than at boot.
 */
describe("OpsWatchModule providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolve, and register ops.watch and jobs.lease-reaper with the scheduler", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    const redis = createFakeRedis() as unknown as RedisService;
    const scheduler = new ScheduledTasksService(redis);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ...OPS_WATCH_PROVIDERS,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: redis },
        { provide: ScheduledTasksService, useValue: scheduler },
        { provide: JobsService, useValue: {} },
        { provide: QueueRegistry, useValue: { prefix: "bull" } },
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(OpsWatchTask)).toBeInstanceOf(OpsWatchTask);
    expect(moduleRef.get(LeaseReaperTask)).toBeInstanceOf(LeaseReaperTask);
    expect(moduleRef.get(AlertSender).destination).toBe("log");
    expect([...scheduler.registered].sort()).toEqual(["jobs.lease-reaper", "ops.watch"]);

    await moduleRef.close();
  });
});
