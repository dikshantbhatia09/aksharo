import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import {
  EdgHotSchema,
  EdgOpSchema,
  EdgSourceSchema,
  ItemStateSchema,
  OpBatchRequestSchema,
  SegmentSchema,
} from "@montaj/edg/schemas";

import { MAX_SEGMENT_PAGE_SIZE, SEGMENT_PAGE_SIZE } from "./edg.errors.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/edg/**`.
 *
 * The **request** schemas come straight from `@montaj/edg/schemas` —
 * `OpBatchRequestSchema` is the frozen envelope of CONTRACTS §2, batch cap
 * included — so the wire format cannot drift from the engine that interprets it.
 * The **response** classes exist for OpenAPI: `pnpm gen:client` reads decorator
 * metadata, and a Zod schema leaves none behind. Segments, ops and passes are
 * declared as opaque objects there and typed precisely in TypeScript, because the
 * generated client re-exports the `@montaj/edg` types rather than a second copy
 * of them.
 */

export class OpBatchRequestDto extends zodDto(OpBatchRequestSchema) {}

/**
 * The four segmenter limits, without the `opId` and `type` the server supplies.
 *
 * Spelled out rather than `.omit()`-ed off `ResegmentOpSchema`: that schema
 * carries a `.check()` refinement (`minMs <= maxMs`), and Zod cannot narrow an
 * object that has one. The bounds are therefore repeated here **and** enforced
 * again by the op the service mints, which is the copy that decides.
 */
const ResegmentRequest = z
  .object({
    maxChars: z.number().int().gt(0).max(200),
    maxLines: z.number().int().gt(0).max(6),
    minMs: z.number().int().min(0),
    maxMs: z.number().int().min(0),
    /** Leave tagged filler words out of the rebuilt captions. */
    dropFillers: z.boolean().optional(),
  })
  .refine((value) => value.minMs <= value.maxMs, {
    message: "minMs must not exceed maxMs",
    path: ["minMs"],
  });

export class ResegmentRequestDto extends zodDto(ResegmentRequest) {}

const SegmentsQuery = z.object({
  /** The previous page's `nextCursor`: the `seq` of its last segment. */
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEGMENT_PAGE_SIZE).optional(),
});

export class SegmentsQueryDto extends zodDto(SegmentsQuery) {}

const ItemsQuery = z.object({ state: ItemStateSchema.optional() });

export class ItemsQueryDto extends zodDto(ItemsQuery) {}

const RevisionsQuery = z.object({
  /** First revision to return, inclusive. Defaults to 1. */
  from: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export class RevisionsQueryDto extends zodDto(RevisionsQuery) {}

/** The internal, signed worker batch: same envelope plus the project it targets. */
const InternalOpBatchRequest = OpBatchRequestSchema.extend({
  ops: z.array(EdgOpSchema).min(1).max(500),
});

export class InternalOpBatchRequestDto extends zodDto(InternalOpBatchRequest) {}

/**
 * `POST /projects/{id}/edg/import` (brief C04 §3): a whole EDG v2 document,
 * written verbatim as revision 1 of a project that has none yet — "Upload to
 * cloud" creates a *new* cloud project from a local one's already-edited
 * document, never a merge onto an existing one (out of scope per the brief).
 *
 * Deliberately not `OpBatchRequestSchema`: the caller is not replaying ops
 * against a revision, it is handing over the whole document the local editor
 * already produced, exactly as `EdgService.initialise` does with a
 * segmenter's output.
 */
const ImportRequest = z.object({
  hot: EdgHotSchema,
  segments: z.array(SegmentSchema).min(1),
  author: z.string().min(1).nullable().optional(),
  source: EdgSourceSchema.optional(),
});

export class ImportRequestDto extends zodDto(ImportRequest) {}

export class ImportResultDto {
  @ApiProperty() edgId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() segments!: number;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class OpRejectionDto {
  @ApiProperty({ description: "The client op id that did not land." })
  opId!: string;

  @ApiProperty({
    enum: [
      "stale",
      "conflict",
      "invalid",
      "invalid-range",
      "not-contiguous",
      "unknown-id",
      "invariant",
      "rebased-away",
      "stale-after-resegment",
      "forbidden",
      "rate-limited",
    ],
    description: "Closed enum (`packages/edg` README). Never free text.",
  })
  reason!: string;

  @ApiPropertyOptional({ description: "Operator-facing detail; not for end users." })
  message?: string;
}

export class OpBatchResponseDto {
  @ApiProperty({ description: "The revision after the batch; unchanged when nothing applied." })
  revision!: number;

  @ApiProperty({ type: [String], description: "Op ids applied as written." })
  applied!: string[];

  @ApiProperty({ type: [String], description: "Op ids applied after a server-side rebase." })
  rebased!: string[];

  @ApiProperty({ type: [OpRejectionDto] })
  rejected!: OpRejectionDto[];
}

export class EdgDocumentDto {
  @ApiProperty({ description: "Compare-and-swap counter; one accepted batch raises it by 1." })
  revision!: number;

  @ApiProperty({ description: "EDG schema generation (D28). Always 2 in this wave." })
  schemaVersion!: number;

  @ApiProperty({
    type: Object,
    description:
      "`EdgHot` from `@montaj/edg` (CONTRACTS §2): meta, media, transcript, canvas, styles.",
  })
  hot!: unknown;

  @ApiProperty({ type: [Object], description: "First page of segments, in `seq` order." })
  segments!: unknown[];

  @ApiPropertyOptional({
    nullable: true,
    description: "Pass as `cursor` to `/edg/segments` for the next page.",
  })
  nextCursor!: string | null;

  @ApiProperty({ type: [Object], description: "Passes with their items." })
  passes!: unknown[];

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}

export class SegmentPageDto {
  @ApiProperty({ type: [Object], description: "`Segment[]` from `@montaj/edg`, in `seq` order." })
  segments!: unknown[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ description: "Revision the page was read at." })
  revision!: number;
}

export class PassListDto {
  @ApiProperty({ type: [Object], description: "`Pass[]` from `@montaj/edg`." })
  passes!: unknown[];
}

export class PassItemListDto {
  @ApiProperty({ type: [Object], description: "`PassItem[]` from `@montaj/edg`." })
  items!: unknown[];
}

export class RevisionDto {
  @ApiProperty() revision!: number;

  @ApiProperty({
    type: [Object],
    description: "The ops as applied. Empty means the state was replaced (a snapshot restore).",
  })
  ops!: unknown[];

  @ApiProperty({ type: [String] }) clientOpIds!: string[];

  @ApiPropertyOptional({ nullable: true, description: "User id, or null for a worker." })
  author!: string | null;

  @ApiProperty({ enum: ["web", "desktop", "premiere", "ae", "resolve", "worker"] })
  source!: string;

  @ApiProperty({ format: "date-time" }) at!: string;
}

export class RevisionPageDto {
  @ApiProperty({ type: [RevisionDto] }) revisions!: RevisionDto[];
  @ApiProperty() latestRevision!: number;
  @ApiPropertyOptional({ nullable: true }) nextFrom!: number | null;
}

export class SnapshotDto {
  @ApiProperty() revision!: number;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

export class SnapshotListDto {
  @ApiProperty({ type: [SnapshotDto] }) snapshots!: SnapshotDto[];
}

export class RestoreResultDto {
  @ApiProperty({ description: "The new revision the restore appended." })
  revision!: number;

  @ApiProperty({ description: "Live segments after the restore." })
  segments!: number;
}

/** The `limit` a segment page uses when the caller does not choose one. */
export const DEFAULT_SEGMENT_LIMIT = SEGMENT_PAGE_SIZE;
