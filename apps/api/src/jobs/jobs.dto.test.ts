import { describe, expect, it } from "vitest";

import {
  JOB_STATUSES,
  ListEventsQueryDto,
  ListJobsQueryDto,
  toJobDto,
  toJobEventDto,
} from "./jobs.dto.js";
import { FakeDb } from "../../test/fakes.js";

const db = new FakeDb();

describe("toJobDto", () => {
  it("renders dates as ISO-8601 and never leaks the credit hold id", () => {
    const job = db.job({
      queuedAt: new Date("2026-09-02T10:00:00.000Z"),
      startedAt: new Date("2026-09-02T10:00:05.000Z"),
      finishedAt: new Date("2026-09-02T10:01:00.000Z"),
      creditHoldId: "01JCHOLD00000000000000000A",
      egressBytes: 4_096n,
    });

    const dto = toJobDto(job);

    expect(dto.queuedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(dto.startedAt).toBe("2026-09-02T10:00:05.000Z");
    expect(dto.finishedAt).toBe("2026-09-02T10:01:00.000Z");
    expect(dto).not.toHaveProperty("creditHoldId");
    // BigInt would make JSON.stringify throw; it must not reach the wire at all.
    expect(dto).not.toHaveProperty("egressBytes");
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it("nulls the optional timestamps and payloads rather than dropping them", () => {
    const dto = toJobDto(db.job({ startedAt: null, finishedAt: null, result: null, error: null }));
    expect(dto.startedAt).toBeNull();
    expect(dto.finishedAt).toBeNull();
    expect(dto.result).toBeNull();
    expect(dto.error).toBeNull();
  });

  it("carries the fields a client polls on", () => {
    const job = db.job({ status: "running", progress: 61, etaMs: 4_000, creditsChargedTenths: 30 });
    expect(toJobDto(job)).toMatchObject({
      status: "running",
      progress: 61,
      etaMs: 4_000,
      creditsChargedTenths: 30,
    });
  });
});

describe("toJobEventDto", () => {
  it("renders the timestamp and keeps the structured data", () => {
    expect(
      toJobEventDto({
        id: "01JCEVENT00000000000000000",
        at: new Date("2026-09-02T10:00:00.000Z"),
        level: "warn",
        message: "queue wait exceeded",
        data: { event: "job.timed_out" },
      }),
    ).toEqual({
      id: "01JCEVENT00000000000000000",
      at: "2026-09-02T10:00:00.000Z",
      level: "warn",
      message: "queue wait exceeded",
      data: { event: "job.timed_out" },
    });
  });
});

describe("query DTOs", () => {
  it("accept the documented filters and coerce a numeric limit", () => {
    const parsed = ListJobsQueryDto.zodSchema.parse({
      status: "queued",
      type: "ai.transcribe",
      limit: "10",
    });
    expect(parsed).toEqual({ status: "queued", type: "ai.transcribe", limit: 10 });
  });

  it("reject an unknown status, an unknown queue and an out-of-range limit", () => {
    expect(ListJobsQueryDto.zodSchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(ListJobsQueryDto.zodSchema.safeParse({ type: "ai.hallucinate" }).success).toBe(false);
    expect(ListJobsQueryDto.zodSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListJobsQueryDto.zodSchema.safeParse({ limit: 1_000 }).success).toBe(false);
    expect(ListJobsQueryDto.zodSchema.safeParse({ cursor: "too-short" }).success).toBe(false);
    expect(ListEventsQueryDto.zodSchema.safeParse({ cursor: "too-short" }).success).toBe(false);
  });

  it("covers every JobStatus the schema defines", () => {
    expect([...JOB_STATUSES].sort()).toEqual([
      "cancelled",
      "failed",
      "queued",
      "running",
      "succeeded",
    ]);
  });
});
