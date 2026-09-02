import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ulid } from "ulid";

import { EvalRunIngestDto } from "./evals.dto.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";

import type { EvalRunIngestAck } from "./evals.dto.js";
import type { SignedInternalRequest } from "../internal/internal-signature.guard.js";

/**
 * `POST /internal/evals/runs` (D08 §3): the worker's nightly (or manual) eval
 * job posts its report here, the same way a job posts its completion
 * (`worker_ai.evals.nightly.post_nightly_report`, signed exactly like
 * CONTRACTS §3's job-completion callback — `InternalSignatureGuard` is the
 * same guard `InternalJobsController` uses).
 *
 * **Idempotent on the signed attempt id.** The guard verifies the HMAC over
 * `X-Montaj-Attempt` and hands the API the attempt id it covered
 * (`request.attemptId`); this controller uses that attempt id as the
 * `EvalRun.id` itself. A retried POST (the worker's `CallbackClient`-style
 * retry-on-5xx behaviour, mirrored by hand in `nightly.post_nightly_report`)
 * therefore lands on the same row rather than double-counting a run, and a
 * genuine replay of an already-applied attempt is answered with
 * `applied: false` and no further writes — the same contract
 * `InternalJobsController`'s completion handler gives a job.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/evals")
export class InternalEvalsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("runs")
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Body() body: EvalRunIngestDto,
    @Req() request: SignedInternalRequest,
  ): Promise<EvalRunIngestAck> {
    // `InternalSignatureGuard` always sets this on a request that reached the
    // handler; the fallback is unreachable in practice and only here so the
    // type is a plain string, not `string | undefined`, below.
    const runId = request.attemptId ?? ulid();

    const existing = await this.prisma.evalRun.findUnique({ where: { id: runId } });
    if (existing !== null) {
      return { runId, applied: false };
    }

    await this.prisma.evalRun.create({
      data: {
        id: runId,
        trigger: body.trigger,
        startedAt: new Date(body.startedAt),
        finishedAt: new Date(body.finishedAt),
        routingFrozen: body.routingFrozen,
        gitSha: body.gitSha ?? null,
        summary: body.summary,
        results: {
          create: body.results.map((row) => ({
            id: ulid(),
            dataset: row.dataset,
            kind: row.kind,
            language: row.language,
            provider: row.provider ?? null,
            metricName: row.metricName,
            metricValue: row.metricValue,
            itemCount: row.itemCount,
          })),
        },
      },
    });

    return { runId, applied: true };
  }
}
