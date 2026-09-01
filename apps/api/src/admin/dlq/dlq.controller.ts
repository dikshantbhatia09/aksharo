import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  BulkDiscardDlqDto,
  BulkOutcomeDto,
  BulkReplayDlqDto,
  DiscardDlqDto,
  DiscardResultDto,
  DlqPageDto,
  DlqStatsDto,
  ListDlqQueryDto,
  ReplayResultDto,
  toDlqEntryDto,
  DlqEntryDto,
} from "./dlq.dto.js";
import { DlqService } from "../../jobs/dlq.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * The dead-letter queue, for platform staff (A08b).
 *
 * Every route is behind {@link AdminGuard}, which means a valid access token whose
 * `users.is_admin` is true; a token belonging to an ordinary user is 403. Unlike
 * `/jobs`, these routes are **not** scoped to the caller's workspace — the whole
 * point of a dead-letter console is to see an incident across tenants — which is
 * exactly why every replay and every discard writes an `audit_log` row naming the
 * admin who did it (THREAT-MODEL T20).
 *
 * B13 builds the admin UI on these routes; `tools/runbooks/dlq-replay.js` drives
 * them from the command line, which is what `docs/runbooks/dlq-replay.md` assumes.
 *
 * **Bulk defaults to a dry run.** `dryRun` is `true` unless a caller says
 * otherwise, so the dangerous shape of the request is the one you have to type out
 * on purpose.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/dlq")
export class AdminDlqController {
  constructor(private readonly dlq: DlqService) {}

  @Get()
  @ApiOperation({
    summary: "List dead-lettered jobs, newest first",
    description:
      "Filter by `queue`, `status`, `workspaceId`, a `reason` substring of the last " +
      "error's code or message, and a `since`/`until` window. Cursor pagination: " +
      "pass the previous page's `nextCursor`.",
    operationId: "listDeadLetters",
  })
  @ApiOkResponse({ type: DlqPageDto })
  async list(@Query() query: ListDlqQueryDto): Promise<DlqPageDto> {
    const page = await this.dlq.list(query);
    return { items: page.items.map(toDlqEntryDto), nextCursor: page.nextCursor };
  }

  @Get("stats")
  @ApiOperation({
    summary: "Per-queue dead-letter counts",
    description:
      "How many, since when, and how many distinct error messages — the three " +
      "numbers `docs/runbooks/dlq-replay.md` asks for before anything is replayed.",
    operationId: "getDeadLetterStats",
  })
  @ApiOkResponse({ type: DlqStatsDto })
  async stats(): Promise<DlqStatsDto> {
    const queues = await this.dlq.stats();
    return {
      queues: [...queues],
      pending: queues.reduce((total, row) => total + row.pending, 0),
    };
  }

  @Post("replay")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replay many dead letters",
    description:
      "By explicit `ids` (entry ids or job ids) or by filter. `dryRun` defaults to " +
      "true: it reports what would be enqueued and reserves nothing. Capped at " +
      "100 entries a call, because a full-throttle replay competes with live " +
      "traffic for the same workers.",
    operationId: "replayDeadLetters",
  })
  @ApiOkResponse({ type: BulkOutcomeDto })
  async replayMany(
    @Req() request: AuthenticatedRequest,
    @Body() body: BulkReplayDlqDto,
  ): Promise<BulkOutcomeDto> {
    const outcome = await this.dlq.bulk({ ...body, action: "replay" }, adminOf(request));
    return { ...outcome, entries: [...outcome.entries] };
  }

  @Post("discard")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Discard many dead letters",
    description: "`discardReason` is mandatory and is recorded on every row.",
    operationId: "discardDeadLetters",
  })
  @ApiOkResponse({ type: BulkOutcomeDto })
  async discardMany(
    @Req() request: AuthenticatedRequest,
    @Body() body: BulkDiscardDlqDto,
  ): Promise<BulkOutcomeDto> {
    const outcome = await this.dlq.bulk({ ...body, action: "discard" }, adminOf(request));
    return { ...outcome, entries: [...outcome.entries] };
  }

  @Get(":id")
  @ApiOperation({
    summary: "One dead letter, by entry id or by job id",
    operationId: "getDeadLetter",
  })
  @ApiOkResponse({ type: DlqEntryDto })
  @ApiNotFoundResponse({ description: "`jobs/dlq_not_found`." })
  async get(@Param("id") id: string): Promise<DlqEntryDto> {
    return toDlqEntryDto(await this.dlq.get(id));
  }

  @Post(":id/replay")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replay one dead letter",
    description:
      "Re-enqueues the same job row with a fresh `attemptId` and the next " +
      "`attemptNo`, preserving `jobKey`, and reserves the original hold again " +
      "through the credits facade.",
    operationId: "replayDeadLetter",
  })
  @ApiOkResponse({ type: ReplayResultDto })
  @ApiNotFoundResponse({ description: "`jobs/dlq_not_found`." })
  @ApiConflictResponse({
    description: "`jobs/dlq_already_resolved` or `jobs/dlq_job_not_failed`.",
  })
  async replay(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ): Promise<ReplayResultDto> {
    return this.dlq.replay(id, adminOf(request));
  }

  @Post(":id/discard")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Discard one dead letter",
    description: "Releases the credit hold and records the reason. `reason` is mandatory.",
    operationId: "discardDeadLetter",
  })
  @ApiOkResponse({ type: DiscardResultDto })
  @ApiNotFoundResponse({ description: "`jobs/dlq_not_found`." })
  @ApiConflictResponse({ description: "`jobs/dlq_already_resolved`." })
  async discard(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: DiscardDlqDto,
  ): Promise<DiscardResultDto> {
    return this.dlq.discard(id, body.reason, adminOf(request));
  }
}
