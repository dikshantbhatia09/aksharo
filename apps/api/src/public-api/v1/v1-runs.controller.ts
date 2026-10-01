import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiForbiddenResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { DEFAULT_PICKABLE_STYLE_ID } from "@montaj/caption-styles";
import { type Env } from "@montaj/config";

import { ApiKeyRateLimitGuard } from "./api-key-rate-limit.guard.js";
import { IdempotencyService } from "./idempotency.service.js";
import { withIdempotency } from "./idempotent.helper.js";
import {
  V1ListRunsQueryDto,
  V1SearchQueryDto,
  V1StartRunDto,
  type V1StartRun,
} from "./v1-runs.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { ApiKeyGuard, ApiScopes, CurrentUser } from "../../common/guards/index.js";
import { ENV } from "../../config/config.module.js";
import { RepurposeClipsService } from "../../repurpose/repurpose-clips.service.js";
import { createRunSchema } from "../../repurpose/repurpose.dto.js";
import { RepurposeService } from "../../repurpose/repurpose.service.js";
import { RepurposeResultsService } from "../../repurpose/results/run-results.service.js";
import { RunSearch } from "../../repurpose/results/run-search.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { RepurposeClipItemView } from "../../repurpose/repurpose-clips.service.js";
import type { RunView } from "../../repurpose/repurpose.dto.js";
import type { RunDefaultsSetup } from "../../repurpose/results/run-results.dto.js";
import type { Request } from "express";

/** A run, as an integration sees it. */
export interface V1Run {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly stage: string;
  readonly progress: number;
  readonly message: string;
  readonly failureCode: string | null;
  readonly autopilot: boolean;
  readonly moments: number;
  readonly clips: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The run's page in the app. */
  readonly appUrl: string;
}

/** One size of a clip; URLs are signed and expire within the hour. */
export interface V1ClipVideo {
  readonly shape: string;
  readonly status: string;
  readonly captionedUrl: string | null;
  readonly cleanUrl: string | null;
}

export interface V1Clip {
  readonly id: string;
  readonly momentId: string;
  readonly title: string | null;
  readonly score: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly state: string;
  readonly videos: readonly V1ClipVideo[];
  readonly images: number;
  /** The clip in the app's editor, once it has a project. */
  readonly editorUrl: string | null;
}

/**
 * `/v1/runs` (2026-10-01, OpusClip parity: the API an MCP server or a script
 * drives): start finding clips in a video from a link, follow the run, list its
 * clips with their files, and find clips by what they are about.
 *
 * `X-Api-Key` only, like every `/v1` route. A run starts on the workspace's
 * saved default setup (`/repurpose/defaults`) when it has one, else on
 * Autopilot with Aksharo's own defaults; the request may change the spoken
 * language, the look, Autopilot, the clip length, the topic and where a long
 * video starts. The rights attestation is the caller's, and must be `true`.
 * Every rule of a run started in the app applies: credits, plan windows, the
 * YouTube gate.
 */
@ApiTags("public")
@ApiSecurity("api-key")
@ApiUnauthorizedResponse({ description: "Missing or invalid `X-Api-Key`." })
@ApiForbiddenResponse({ description: "The key lacks the required scope." })
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
@Controller("v1/runs")
export class V1RunsController {
  constructor(
    private readonly runs: RepurposeService,
    private readonly clips: RepurposeClipsService,
    private readonly results: RepurposeResultsService,
    private readonly finder: RunSearch,
    private readonly idempotency: IdempotencyService,
    private readonly audit: CommonAuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post()
  @ApiScopes("projects_write")
  @ApiOperation({
    summary: "Find clips in a video from a link",
    description:
      "Starts a run on the workspace's saved default setup (else Autopilot with Aksharo's " +
      "defaults), changed by any field given. `rightsAttested` must be true.",
    operationId: "v1StartRun",
  })
  async start(
    @Req() request: Request,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: V1StartRunDto,
  ): Promise<V1Run> {
    return withIdempotency(
      this.idempotency,
      request,
      principal.workspaceId,
      "POST /v1/runs",
      body,
      async () => {
        const saved = (await this.results.defaults(principal.workspaceId)).setup;
        const parsed = createRunSchema.safeParse({
          source: { kind: "url", url: body.url, rightsAttested: true },
          setup: setupFor(saved, body),
        });
        if (!parsed.success) {
          throw new AppException(
            ERROR_CODES.validationFailed,
            parsed.error.issues.map((issue) => issue.message).join(" "),
            HttpStatus.BAD_REQUEST,
          );
        }
        const created = await this.runs.create(
          principal.workspaceId,
          principal.userId,
          parsed.data,
        );
        await this.audit.record({
          action: "public_api.run.started",
          resource: "repurpose_run",
          resourceId: created.run.id,
          actorId: principal.userId,
          actorKind: "api",
          workspaceId: principal.workspaceId,
          data: { fromDefaults: saved !== null },
        });
        return this.toRun(created.run as RunView);
      },
    );
  }

  @Get()
  @ApiScopes("projects_read")
  @ApiOperation({ summary: "The workspace's runs, newest first", operationId: "v1ListRuns" })
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: V1ListRunsQueryDto,
  ): Promise<{ readonly runs: readonly V1Run[]; readonly nextCursor: string | null }> {
    const page = await this.runs.list(principal.workspaceId, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return {
      runs: page.items.map((run) => this.toRun(run)),
      nextCursor: page.nextCursor ?? null,
    };
  }

  @Get(":runId")
  @ApiScopes("projects_read")
  @ApiOperation({ summary: "Where a run is", operationId: "v1GetRun" })
  async get(
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
  ): Promise<V1Run> {
    return this.toRun(await this.runs.get(principal.workspaceId, runId));
  }

  @Get(":runId/clips")
  @ApiScopes("projects_read")
  @ApiOperation({
    summary: "A run's clips and their files",
    description:
      "Every size with and without captions; the URLs are signed and expire within the hour.",
    operationId: "v1ListRunClips",
  })
  async listClips(
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
  ): Promise<{ readonly runId: string; readonly clips: readonly V1Clip[] }> {
    const listed = await this.clips.listClips(principal.workspaceId, runId);
    return { runId, clips: listed.clips.map((clip) => this.toClip(clip)) };
  }

  @Get(":runId/search")
  @ApiScopes("projects_read")
  @ApiOperation({
    summary: "A run's moments closest in meaning to a question",
    operationId: "v1SearchRun",
  })
  async search(
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Query() query: V1SearchQueryDto,
  ): Promise<{
    readonly semantic: boolean;
    readonly matches: readonly { readonly momentId: string; readonly score: number }[];
  }> {
    await this.results.assertRun(principal.workspaceId, runId);
    const result = await this.finder.search(runId, query.q);
    return {
      semantic: result.semantic,
      matches: result.matches.map((match) => ({ momentId: match.candidateId, score: match.score })),
    };
  }

  private toRun(run: RunView): V1Run {
    return {
      id: run.id,
      title: run.sourceTitle ?? null,
      status: run.status,
      stage: run.currentStage,
      progress: run.progress,
      message: run.message,
      failureCode: run.failureCode,
      autopilot: run.automation === "auto",
      moments: run.candidateCount,
      clips: run.clipCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      appUrl: new URL(`/repurpose/${run.id}`, this.env.WEB_ORIGIN).toString(),
    };
  }

  private toClip(clip: RepurposeClipItemView): V1Clip {
    // The clip view carries its row and relations beside the named fields.
    const row = clip as unknown as {
      readonly title?: string | null;
      readonly variants?: readonly { readonly projectId: string; readonly aspect: string }[];
      readonly candidate?: {
        readonly title?: string;
        readonly potentialScore?: number | null;
        readonly startMs?: number;
        readonly endMs?: number;
      } | null;
    };
    const variants = row.variants ?? [];
    const vertical = variants.find((variant) => variant.aspect === "r9x16") ?? variants.at(0);
    const videos: V1ClipVideo[] =
      clip.formats.length > 0
        ? clip.formats.map((format) => ({
            shape: format.shape,
            status: format.status,
            captionedUrl: format.captioned?.downloadUrl ?? null,
            cleanUrl: format.cleanUrl,
          }))
        : [
            {
              shape: "9:16",
              status: clip.captioned?.status ?? clip.state,
              captionedUrl: clip.captioned?.downloadUrl ?? null,
              cleanUrl: clip.mezzanineUrl,
            },
          ];
    const moment = row.candidate ?? null;
    return {
      id: clip.id,
      momentId: clip.candidateId,
      title: row.title ?? moment?.title ?? null,
      score: moment?.potentialScore ?? null,
      startMs: moment?.startMs ?? null,
      endMs: moment?.endMs ?? null,
      state: clip.state,
      videos,
      images: clip.images.files.reduce((sum, file) => sum + file.items.length, 0),
      editorUrl:
        vertical === undefined
          ? null
          : new URL(`/p/${vertical.projectId}`, this.env.WEB_ORIGIN).toString(),
    };
  }
}

/** The run's setup: the saved default (or Aksharo's), changed by the request. */
export function setupFor(
  saved: RunDefaultsSetup | null,
  body: V1StartRun,
): Record<string, unknown> {
  const base: Record<string, unknown> = saved ?? {
    sourceLanguage: "auto",
    caption: { outputLanguage: "same", scriptMode: "auto", styleId: DEFAULT_PICKABLE_STYLE_ID },
    discovery: { mode: "ai", requestedCandidates: 5, clipLength: "medium" },
    automation: "auto",
  };
  const caption = base["caption"] as Record<string, unknown>;
  const discovery = base["discovery"] as Record<string, unknown>;
  return {
    ...base,
    ...(body.sourceLanguage === undefined ? {} : { sourceLanguage: body.sourceLanguage }),
    caption: { ...caption, ...(body.styleId === undefined ? {} : { styleId: body.styleId }) },
    discovery: {
      ...discovery,
      // A link run's moments are always found for it: "manual" needs a person.
      mode: "ai",
      requestedCandidates:
        typeof discovery["requestedCandidates"] === "number" && discovery["requestedCandidates"] > 0
          ? discovery["requestedCandidates"]
          : 5,
      ...(body.clipLength === undefined ? {} : { clipLength: body.clipLength }),
      ...(body.topic === undefined ? {} : { topic: body.topic }),
    },
    ...(body.autopilot === undefined ? {} : { automation: body.autopilot ? "auto" : "manual" }),
    ...(body.startAtMs === undefined ? {} : { window: { startMs: body.startAtMs } }),
  };
}
