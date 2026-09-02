import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import {
  OUTPUT_KINDS,
  RENDER_PRESETS,
  SUBTITLE_FORMATS,
  SUBTITLE_SCRIPTS,
  WATERMARK_POSITIONS,
} from "@montaj/render-manifest";

import { zodDto } from "../common/index.js";
import { ulidSchema } from "../projects/projects.dto.js";

/**
 * Request and response shapes for `/projects/{id}/exports`, `/exports/*` and
 * `/workspaces/{id}/brand-assets`.
 *
 * As everywhere else, **requests** are Zod (validated by the global pipe) and
 * **responses** are classes with `@ApiProperty` (what `pnpm gen:client` reads).
 * The signed manifest itself is declared as an opaque object — `@montaj/api-client`
 * consumers verify it with `@montaj/render-manifest`, not by trusting a second,
 * hand-typed copy of the schema here.
 */

const CapabilitiesRequest = z.object({
  codecs: z.array(z.string().min(1).max(64)).max(16).optional(),
  audioEncoder: z.boolean().optional(),
  discardedTracks: z.array(z.string().min(1).max(64)).max(16).optional(),
  fileSink: z.boolean().optional(),
  isDesktopChromium: z.boolean().optional(),
  isMobile: z.boolean().optional(),
  throughputMbps: z.number().positive().optional(),
});

const SubtitleOptionsRequest = z.object({
  formats: z.array(z.enum(SUBTITLE_FORMATS)).min(1).max(SUBTITLE_FORMATS.length),
  scripts: z.array(z.enum(SUBTITLE_SCRIPTS)).min(1).max(SUBTITLE_SCRIPTS.length).default(["roman"]),
});

const ExportOptionsRequest = z.object({
  /** A workspace's own logo, deliberately overlaid even on an unwatermarked export. */
  brandAssetId: ulidSchema.optional(),
  watermarkPosition: z.enum(WATERMARK_POSITIONS).default("bottom-right"),
  watermarkOpacity: z.number().min(0).max(1).default(1),
});

const ExportRequest = z
  .object({
    kind: z.enum(["video", "subtitle"]).default("video"),
    preset: z.enum(RENDER_PRESETS).default("reels"),
    /** Video only; caption-only layers are cloud-only (D34). */
    outputKind: z.enum(OUTPUT_KINDS).default("video"),
    customWidth: z.number().int().min(16).max(7_680).optional(),
    customHeight: z.number().int().min(16).max(7_680).optional(),
    /** Which of a word's scripts to burn in / embed. */
    script: z.enum(SUBTITLE_SCRIPTS).default("roman"),
    mode: z.enum(["auto", "browser", "cloud"]).default("auto"),
    dropFillers: z.boolean().default(false),
    subtitle: SubtitleOptionsRequest.optional(),
    capabilities: CapabilitiesRequest.optional(),
    options: ExportOptionsRequest.default({
      watermarkPosition: "bottom-right",
      watermarkOpacity: 1,
    }),
  })
  .check((ctx) => {
    const value = ctx.value;
    if (
      value.preset === "custom" &&
      (value.customWidth === undefined || value.customHeight === undefined)
    ) {
      ctx.issues.push({
        code: "custom",
        input: value,
        path: ["customWidth"],
        message: 'customWidth and customHeight are required when preset is "custom".',
      });
    }
    if (value.kind === "subtitle" && value.subtitle === undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        path: ["subtitle"],
        message: 'subtitle.formats is required when kind is "subtitle".',
      });
    }
  });

export class ExportRequestDto extends zodDto(ExportRequest) {}

const ManifestCompleteRequest = z.object({
  sizeBytes: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  checksum: z.string().trim().min(1).max(256),
});

export class ManifestCompleteRequestDto extends zodDto(ManifestCompleteRequest) {}

const ExportListQuery = z.object({
  cursor: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export class ExportListQueryDto extends zodDto(ExportListQuery) {}

const BrandAssetCreateRequest = z.object({
  contentType: z.enum(["image/png"]).default("image/png"),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
});

export class BrandAssetCreateRequestDto extends zodDto(BrandAssetCreateRequest) {}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class ExportQuoteDto {
  @ApiProperty({ description: "Credits held, in tenths. 0 for browser and subtitle exports." })
  tenths!: number;

  @ApiProperty({ description: '"0.5" — for display only, never for arithmetic.' })
  credits!: string;
}

export class ExportJobDto {
  @ApiProperty({ description: "Poll `GET /jobs/{id}` or listen for `job.completed`." })
  jobId!: string;

  @ApiProperty({ description: "`queued`, or the live job's status when deduplicated." })
  status!: string;

  @ApiProperty({ description: "True when an identical job was already running." })
  deduplicated!: boolean;
}

export class ExportSourcesDto {
  @ApiProperty({ description: "15-minute signed GET for the ORIGINAL media (S3)." })
  rawUrl!: string;

  @ApiPropertyOptional({
    description: "15-minute signed GET for the 540p proxy (R2), when one exists.",
  })
  proxyUrl?: string;

  @ApiPropertyOptional({
    description: "15-minute signed GET for the watermark PNG (R2), when the manifest carries one.",
  })
  watermarkUrl?: string;
}

export class ExportDecisionResponseDto {
  @ApiProperty() exportId!: string;

  @ApiProperty({ enum: ["browser", "cloud"] })
  path!: "browser" | "cloud";

  @ApiProperty({ type: [String], description: "Human-readable, UI-safe (`08 §Export dialog`)." })
  reasons!: string[];

  @ApiProperty() watermarked!: boolean;

  @ApiProperty({ type: ExportQuoteDto })
  quote!: ExportQuoteDto;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description:
      "The signed `RenderManifest` (`@montaj/render-manifest`), present on the browser path only — " +
      "the browser renders locally and never uploads. Verify it before drawing a frame.",
  })
  manifest?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: ExportSourcesDto,
    description:
      "Present on the browser path only. NOT part of the signed manifest body — issued alongside " +
      "it, and refreshable at `GET /exports/manifests/{id}/sources` once these expire.",
  })
  sources?: ExportSourcesDto;

  @ApiPropertyOptional({ type: ExportJobDto, description: "Present on the cloud path only." })
  job?: ExportJobDto;
}

export class ManifestCompleteResponseDto {
  @ApiProperty() exportId!: string;
  @ApiProperty({ enum: ["succeeded"] }) status!: "succeeded";
  @ApiProperty() downloadAvailable!: boolean;
}

export class ExportDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty({ enum: ["pending_browser", "succeeded", "failed"] }) status!: string;
  @ApiProperty() kind!: string;
  @ApiPropertyOptional({ nullable: true }) preset?: string | null;
  @ApiProperty() watermarked!: boolean;
  @ApiPropertyOptional({ nullable: true }) resolution?: string | null;
  @ApiPropertyOptional({ nullable: true }) durationMs?: number | null;
  @ApiPropertyOptional({ nullable: true }) sizeBytes?: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt?: string | null;
  @ApiProperty() downloads!: number;
  @ApiProperty() createdAt!: string;
}

export class ExportListDto {
  @ApiProperty({ type: [ExportDto] })
  items!: ExportDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class ExportDownloadDto {
  @ApiProperty({ description: "Short-lived R2 signed URL." })
  url!: string;

  @ApiProperty()
  expiresAt!: string;
}

export class BrandAssetDto {
  @ApiProperty() id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() contentType!: string;
  @ApiPropertyOptional({ nullable: true }) sizeBytes?: number | null;
  @ApiProperty() createdAt!: string;
}

export class BrandAssetUploadDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "Single-shot presigned PUT URL for the PNG bytes." })
  uploadUrl!: string;
  @ApiProperty()
  expiresAt!: string;
}
