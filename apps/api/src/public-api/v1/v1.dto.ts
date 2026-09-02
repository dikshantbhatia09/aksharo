import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { RENDER_PRESETS } from "@montaj/render-manifest";

import { zodDto } from "../../common/index.js";
import { ulidSchema } from "../../projects/projects.dto.js";

const CreateProjectRequest = z
  .object({
    title: z.string().min(1).max(200),
    /** Fetched under the SSRF guard and attached as the project's primary media. */
    sourceUrl: z.string().url().max(2048).optional(),
  })
  .check((ctx) => {
    if (ctx.value.sourceUrl !== undefined && !ctx.value.sourceUrl.startsWith("https://")) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["sourceUrl"],
        message: "sourceUrl must be https.",
      });
    }
  });
export class V1CreateProjectRequestDto extends zodDto(CreateProjectRequest) {}

export class V1ProjectDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ nullable: true }) durationMs?: number | null;
  @ApiProperty() createdAt!: string;
}

const TranscribeRequest = z.object({
  languages: z.array(z.string().min(2).max(10)).max(5).optional(),
  hints: z.array(z.string().min(1).max(80)).max(50).optional(),
});
export class V1TranscribeRequestDto extends zodDto(TranscribeRequest) {}

export class V1TranscribeAcceptedDto {
  @ApiProperty() jobId!: string;
  @ApiProperty() transcriptId!: string;
  @ApiProperty() status!: string;
}

export const V1_TRANSCRIPT_FORMATS = ["json", "srt", "vtt"] as const;
const TranscriptQuery = z.object({
  format: z.enum(V1_TRANSCRIPT_FORMATS).default("json"),
});
export class V1TranscriptQueryDto extends zodDto(TranscriptQuery) {}

const CreateExportRequest = z.object({
  preset: z.enum(RENDER_PRESETS).default("reels"),
  /** Alias for `options.brandAssetId` — the public API's name for the export's visual style. */
  styleId: ulidSchema.optional(),
  watermark: z.boolean().optional(),
});
export class V1CreateExportRequestDto extends zodDto(CreateExportRequest) {}

export class V1ExportAcceptedDto {
  @ApiProperty() exportId!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() jobId?: string;
}

export class V1ExportDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ nullable: true }) downloadUrl?: string | null;
  @ApiProperty() createdAt!: string;
}

export class V1JobDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() status!: string;
  @ApiProperty() progress!: number;
  @ApiPropertyOptional({ nullable: true }) error?: unknown;
  @ApiProperty() createdAt!: string;
}
