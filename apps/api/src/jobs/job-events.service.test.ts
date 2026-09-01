import { beforeEach, describe, expect, it, vi } from "vitest";

import { JobEventsService } from "./job-events.service.js";
import { JOB_EVENT_RETENTION_DAYS } from "./jobs.config.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

let db: FakeDb;
let events: JobEventsService;

beforeEach(() => {
  db = new FakeDb();
  events = new JobEventsService(createFakePrisma(db) as unknown as PrismaService);
});

describe("row", () => {
  it("stamps the event name and a 30-day retention marker (D47)", () => {
    const before = Date.now();
    const row = events.row({ jobId: "job-1", name: "job.queued" });
    const data = row.data as { event: string; retainUntil: string; retentionDays: number };

    expect(row.id).toHaveLength(26);
    expect(row.jobId).toBe("job-1");
    expect(row.level).toBe("info");
    expect(row.message).toBe("job.queued");
    expect(data.event).toBe("job.queued");
    expect(data.retentionDays).toBe(JOB_EVENT_RETENTION_DAYS);
    const retainUntil = Date.parse(data.retainUntil);
    expect(retainUntil).toBeGreaterThanOrEqual(before + JOB_EVENT_RETENTION_DAYS * 86_400_000 - 5);
  });

  it("keeps the caller's message, level and structured context", () => {
    const row = events.row({
      jobId: "job-1",
      name: "job.failed",
      level: "error",
      message: "upstream timed out",
      data: { attempt: 2 },
    });
    expect(row.level).toBe("error");
    expect(row.message).toBe("upstream timed out");
    expect(row.data).toMatchObject({ event: "job.failed", attempt: 2 });
  });

  it("mints ids that sort in write order, which is what the cursor relies on", () => {
    const ids = Array.from(
      { length: 50 },
      () => events.row({ jobId: "j", name: "job.progress" }).id,
    );
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("append", () => {
  it("writes the row", async () => {
    await events.append({ jobId: "job-1", name: "job.started" });
    expect(db.eventNames("job-1")).toEqual(["job.started"]);
  });

  it("never throws: an audit row must not fail the transition it describes", async () => {
    const prisma = {
      jobEvent: {
        create: vi.fn(async () => {
          throw new Error("database is gone");
        }),
      },
    } as unknown as PrismaService;

    await expect(
      new JobEventsService(prisma).append({ jobId: "job-1", name: "job.succeeded" }),
    ).resolves.toBeUndefined();
  });
});
