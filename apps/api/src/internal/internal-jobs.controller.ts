import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";
import {
  EnqueueChildSchema,
  JobCompletionSchema,
  JobProgressSchema,
} from "../jobs/contracts/completion.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { JobsService } from "../jobs/jobs.service.js";

import type { SignedInternalRequest } from "./internal-signature.guard.js";
import type { CallbackAck } from "../jobs/contracts/completion.js";

export class JobProgressDto extends zodDto(JobProgressSchema) {}
export class JobCompletionDto extends zodDto(JobCompletionSchema) {}
export class EnqueueChildDto extends zodDto(EnqueueChildSchema) {}

export interface EnqueueChildAck {
  readonly jobId: string;
  readonly childJobId: string;
  readonly deduplicated: boolean;
}

/**
 * Worker → API callbacks (CONTRACTS §3).
 *
 * `@ApiExcludeController` keeps the whole surface out of `/docs` and therefore out
 * of `@montaj/api-client`: these routes are not part of the product's API, they
 * are the inside of the job system, and publishing them would invite a client to
 * try to call them (THREAT-MODEL T8).
 *
 * Authentication is the shared-secret HMAC of {@link InternalSignatureGuard} —
 * never a JWT, because a worker has no user. Every handler is **idempotent** on
 * `(jobId, attemptId)`, so the at-least-once delivery a retrying worker provides
 * is safe: a replay answers 200 with `applied: false` and changes nothing.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/jobs")
export class InternalJobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(":id/progress")
  @HttpCode(HttpStatus.OK)
  async progress(
    @Req() request: SignedInternalRequest,
    @Param("id") id: string,
    @Body() body: JobProgressDto,
  ): Promise<CallbackAck> {
    return this.jobs.recordProgress(id, attemptOf(request), body);
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  async complete(
    @Req() request: SignedInternalRequest,
    @Param("id") id: string,
    @Body() body: JobCompletionDto,
  ): Promise<CallbackAck> {
    return this.jobs.complete(id, attemptOf(request), body);
  }

  /**
   * A follow-up the worker discovered it needs — `media.probe` finding that a
   * proxy must be built, `ai.transcribe` chaining `ai.align`.
   *
   * The child's workspace and project come from the parent row, never from the
   * body, so a compromised worker cannot enqueue into another tenant.
   */
  @Post(":id/enqueue-child")
  @HttpCode(HttpStatus.OK)
  async enqueueChild(
    @Req() request: SignedInternalRequest,
    @Param("id") id: string,
    @Body() body: EnqueueChildDto,
  ): Promise<EnqueueChildAck> {
    const parent = await this.prisma.job.findUnique({ where: { id } });
    if (parent === null) {
      throw new AppException(JOB_ERROR_CODES.notFound, "No such job.", HttpStatus.NOT_FOUND, {
        jobId: id,
      });
    }
    const attemptId = attemptOf(request);
    if (parent.attemptId !== null && parent.attemptId !== attemptId) {
      // A superseded attempt must not fan out: its child would duplicate the one
      // the live attempt is about to ask for.
      throw new AppException(
        JOB_ERROR_CODES.invalidState,
        "This attempt is no longer the live one.",
        HttpStatus.CONFLICT,
        { jobId: id },
      );
    }

    const result = await this.jobs.enqueueChild(parent, body);
    return { jobId: id, childJobId: result.job.id, deduplicated: result.deduplicated };
  }
}

/** The guard has already verified this; the `?? ""` is only to satisfy the type. */
function attemptOf(request: SignedInternalRequest): string {
  return request.attemptId ?? "";
}
