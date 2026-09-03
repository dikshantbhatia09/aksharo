import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  EdgDocumentDto,
  ImportRequestDto,
  ImportResultDto,
  ItemsQueryDto,
  OpBatchRequestDto,
  OpBatchResponseDto,
  PassItemListDto,
  PassListDto,
  ResegmentRequestDto,
  RestoreResultDto,
  RevisionPageDto,
  RevisionsQueryDto,
  SegmentPageDto,
  SegmentsQueryDto,
  SnapshotListDto,
} from "./edg.dto.js";
import { SEGMENT_PAGE_SIZE } from "./edg.errors.js";
import { EdgService } from "./edg.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * The editing surface of CONTRACTS §2 — the document, its pages, and the one
 * write endpoint every client shares.
 *
 * **Who may write.** `@Roles("editor")` admits editor, admin and owner (the
 * guard reads the ladder, so a route never enumerates it); a `viewer` reads and
 * is refused a write with `common/forbidden`. A share-link reviewer holds no
 * membership at all, so it cannot reach these routes — its comments are B15's
 * surface, not this one.
 *
 * **Which workspace.** The `ws` claim, always: the service resolves
 * `(projectId, workspaceId)` and a project belonging to somebody else is a 404
 * (THREAT-MODEL T4, T5).
 */
@ApiTags("edg")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`, or `edg/not_initialised`." })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("projects/:projectId/edg")
export class EdgController {
  constructor(private readonly edg: EdgService) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The hot document, its revision and the first page of segments",
    description:
      "The hot state is under 64 KB. Segments are paged — `nextCursor` continues at " +
      "`/edg/segments` — because a long-form project has thousands and an editor " +
      "opens on the first screenful.",
    operationId: "getProjectEdg",
  })
  @ApiOkResponse({ type: EdgDocumentDto })
  async document(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<EdgDocumentDto> {
    const view = await this.edg.document(projectId, principal.workspaceId);
    return {
      revision: view.revision,
      schemaVersion: view.schemaVersion,
      hot: view.hot,
      segments: view.segments,
      nextCursor: view.nextCursor,
      passes: view.passes,
      updatedAt: view.updatedAt,
    };
  }

  @Get("segments")
  @Roles("viewer")
  @ApiOperation({
    summary: "One page of segments, ordered by `seq`",
    description:
      "The cursor is the previous page's last `seq`, so an edit three pages back " +
      "cannot make a later page skip a caption.",
    operationId: "listEdgSegments",
  })
  @ApiOkResponse({ type: SegmentPageDto })
  async segments(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: SegmentsQueryDto,
  ): Promise<SegmentPageDto> {
    return this.edg.segments(
      projectId,
      principal.workspaceId,
      query.cursor,
      query.limit ?? SEGMENT_PAGE_SIZE,
    );
  }

  @Get("passes")
  @Roles("viewer")
  @ApiOperation({
    summary: "Every AI pass on the document, with its items",
    operationId: "listEdgPasses",
  })
  @ApiOkResponse({ type: PassListDto })
  async passes(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<PassListDto> {
    return { passes: await this.edg.passes(projectId, principal.workspaceId) };
  }

  @Get("passes/:passId/items")
  @Roles("viewer")
  @ApiOperation({
    summary: "One pass's proposals, optionally filtered by review state",
    operationId: "listEdgPassItems",
  })
  @ApiOkResponse({ type: PassItemListDto })
  async items(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Param("passId") passId: string,
    @Query() query: ItemsQueryDto,
  ): Promise<PassItemListDto> {
    return { items: await this.edg.items(projectId, principal.workspaceId, passId, query.state) };
  }

  @Get("revisions")
  @Roles("viewer")
  @ApiOperation({
    summary: "The op log from `from` onwards",
    description:
      "A revision with no ops replaced the state wholesale (a snapshot restore); a " +
      "client that finds one between its base and now must reload rather than replay.",
    operationId: "listEdgRevisions",
  })
  @ApiOkResponse({ type: RevisionPageDto })
  async revisions(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: RevisionsQueryDto,
  ): Promise<RevisionPageDto> {
    return this.edg.revisions(projectId, principal.workspaceId, query.from ?? 1, query.limit);
  }

  @Get("snapshots")
  @Roles("viewer")
  @ApiOperation({
    summary: "Revisions a snapshot was taken at, newest first",
    operationId: "listEdgSnapshots",
  })
  @ApiOkResponse({ type: SnapshotListDto })
  async snapshots(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<SnapshotListDto> {
    return { snapshots: await this.edg.snapshots(projectId, principal.workspaceId) };
  }

  @Post("ops")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Apply a batch of ops (CONTRACTS §2)",
    description:
      "A batch written against an older revision is rebased server-side and applied; " +
      "the ops that had to be rewritten come back under `rebased`. Two writers who " +
      "typed different text into the same caption cannot be reconciled by the server, " +
      "so that is a 409 `edg/conflict` carrying `{latestRevision, opsSince, conflicts}` " +
      "— never the document. More than 200 revisions behind is `edg/too_stale`: reload.",
    operationId: "applyEdgOps",
  })
  @ApiOkResponse({ type: OpBatchResponseDto })
  @ApiConflictResponse({ description: "`edg/conflict` or `edg/too_stale`." })
  @ApiForbiddenResponse({ description: "`common/forbidden` — a viewer may not write." })
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited` — the workspace op budget." })
  async ops(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: OpBatchRequestDto,
  ): Promise<OpBatchResponseDto> {
    return this.edg.applyOps({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      baseRevision: body.baseRevision,
      ops: body.ops,
      clientOpIds: body.clientOpIds,
      source: sourceOf(principal.kind),
    });
  }

  @Post("resegment")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Re-run segmentation over the whole document",
    description:
      "The server mints the `Resegment` op, so the audited record of what happened " +
      "carries an id this API can vouch for. Every previous segment id is tombstoned; " +
      "style, position and `hidden` are inherited by whichever new segment overlaps.",
    operationId: "resegmentEdg",
  })
  @ApiOkResponse({ type: OpBatchResponseDto })
  @ApiConflictResponse({ description: "`edg/conflict` or `edg/too_stale`." })
  async resegment(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: ResegmentRequestDto,
  ): Promise<OpBatchResponseDto> {
    return this.edg.resegment({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      params: {
        maxChars: body.maxChars,
        maxLines: body.maxLines,
        minMs: body.minMs,
        maxMs: body.maxMs,
      },
      ...(body.dropFillers === undefined ? {} : { dropFillers: body.dropFillers }),
      source: sourceOf(principal.kind),
    });
  }

  @Post("import")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Write a whole EDG document as revision 1 of a fresh project",
    description:
      "The desktop's 'Upload to cloud' (brief C04 §3): creates a new cloud project " +
      "from a local one's already-edited document, handed over verbatim rather than " +
      "replayed as ops. Never a merge — a project that already has a document " +
      "refuses with `edg/already_imported`.",
    operationId: "importEdgDocument",
  })
  @ApiOkResponse({ type: ImportResultDto })
  @ApiConflictResponse({ description: "`edg/already_imported`." })
  async import(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: ImportRequestDto,
  ): Promise<ImportResultDto> {
    return this.edg.importSnapshot({
      projectId,
      workspaceId: principal.workspaceId,
      hot: body.hot,
      segments: body.segments,
      author: body.author ?? principal.userId,
      source: body.source ?? sourceOf(principal.kind),
    });
  }

  @Post("snapshots/:revision/restore")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Restore a snapshot as a new revision",
    description:
      "History is never rewritten: the restore is appended, so restoring a later " +
      "snapshot undoes it. The transcript is not rolled back — words live in their " +
      "own table and a spelling fixed after the snapshot stays fixed. A snapshot " +
      "that names a word the transcript no longer has live is refused with " +
      "`edg/restore_invalid` and the dangling ids, rather than written as a " +
      "caption nothing can render.",
    operationId: "restoreEdgSnapshot",
  })
  @ApiOkResponse({ type: RestoreResultDto })
  @ApiNotFoundResponse({ description: "`edg/snapshot_not_found`." })
  @ApiConflictResponse({
    description: "`edg/restore_invalid` — `details.danglingWordIds` names the words.",
  })
  async restore(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Param("revision") revision: string,
  ): Promise<RestoreResultDto> {
    return this.edg.restore({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      snapshotRevision: Number.parseInt(revision, 10),
      source: sourceOf(principal.kind),
    });
  }
}

/**
 * The client kind of the access token, as an `EdgSource`.
 *
 * `api` has no surface of its own in CONTRACTS §2's enum and is recorded as
 * `desktop`'s sibling `web`; `worker` is never derived from a token, because the
 * only writer allowed to claim it is the signed internal surface.
 */
function sourceOf(kind: AuthPrincipal["kind"]): "web" | "desktop" | "premiere" | "ae" | "resolve" {
  switch (kind) {
    case "desktop":
      return "desktop";
    case "premiere":
      return "premiere";
    case "ae":
      return "ae";
    case "resolve":
      return "resolve";
    default:
      return "web";
  }
}
