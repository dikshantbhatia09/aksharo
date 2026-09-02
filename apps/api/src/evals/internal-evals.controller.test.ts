import { describe, expect, it, vi } from "vitest";

import { EvalRunIngestDto } from "./evals.dto.js";
import { InternalEvalsController } from "./internal-evals.controller.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { SignedInternalRequest } from "../internal/internal-signature.guard.js";

function parse(body: unknown): Record<string, unknown> {
  return EvalRunIngestDto.zodSchema.parse(body) as Record<string, unknown>;
}

function harness(existing: Record<string, unknown> | null = null): {
  controller: InternalEvalsController;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => undefined);
  const prisma = {
    evalRun: {
      findUnique: vi.fn(async () => existing),
      create,
    },
  } as unknown as PrismaService;
  return { controller: new InternalEvalsController(prisma), create };
}

function signedRequest(attemptId = "01JATT0000000000000000000A"): SignedInternalRequest {
  return { attemptId } as unknown as SignedInternalRequest;
}

const BODY = {
  trigger: "nightly",
  startedAt: "2026-09-03T02:30:00.000Z",
  finishedAt: "2026-09-03T02:35:00.000Z",
  routingFrozen: false,
  gitSha: "abc123",
  summary: { datasetsRun: ["hindi-synth"], datasetsSkipped: [] },
  results: [
    {
      dataset: "hindi-synth",
      kind: "transcript",
      language: "hi",
      metricName: "corpusWer",
      metricValue: 0.12,
      itemCount: 3,
    },
  ],
};

describe("EvalRunIngestSchema", () => {
  it("accepts a well-formed nightly report", () => {
    expect(() => parse(BODY)).not.toThrow();
  });

  it("rejects an unknown trigger", () => {
    expect(() => parse({ ...BODY, trigger: "whenever" })).toThrow();
  });

  it("rejects an unknown metric kind", () => {
    expect(() => parse({ ...BODY, results: [{ ...BODY.results[0], kind: "vibes" }] })).toThrow();
  });
});

describe("InternalEvalsController.ingest", () => {
  it("creates a run keyed by the signed attempt id, with nested results", async () => {
    const h = harness(null);
    const dto = parse(BODY) as unknown as ReturnType<typeof EvalRunIngestDto.zodSchema.parse>;
    const ack = await h.controller.ingest(
      dto as never,
      signedRequest("01JRUN0000000000000000000A"),
    );

    expect(ack).toEqual({ runId: "01JRUN0000000000000000000A", applied: true });
    expect(h.create).toHaveBeenCalledTimes(1);
    const call = h.create.mock.calls[0]?.[0] as {
      data: { id: string; results: { create: unknown[] } };
    };
    expect(call.data.id).toBe("01JRUN0000000000000000000A");
    expect(call.data.results.create).toHaveLength(1);
  });

  it("is idempotent: a replayed attempt id is not applied twice", async () => {
    const h = harness({ id: "01JRUN0000000000000000000A" });
    const dto = parse(BODY) as unknown as ReturnType<typeof EvalRunIngestDto.zodSchema.parse>;
    const ack = await h.controller.ingest(
      dto as never,
      signedRequest("01JRUN0000000000000000000A"),
    );

    expect(ack).toEqual({ runId: "01JRUN0000000000000000000A", applied: false });
    expect(h.create).not.toHaveBeenCalled();
  });
});
