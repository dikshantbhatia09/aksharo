import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { MAX_INSIGHT_KINDS_PER_REQUEST } from "./insights.errors.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/insights` (B11, F-206/F-207).
 *
 * Requests are Zod, validated by the global pipe; responses are classes so
 * `pnpm gen:client` has decorator metadata to read, the same split
 * `transcripts.dto.ts` makes.
 */

const InsightKind = z.enum(["chapters", "summary", "hooks"]);

/** Regeneration tone (brief §4: "regenerate with a different tone"). */
const InsightTone = z.enum(["energetic", "calm", "bold", "informative"]);

const InsightsRequest = z.object({
  kinds: z.array(InsightKind).min(1).max(MAX_INSIGHT_KINDS_PER_REQUEST),
  tone: InsightTone.optional(),
  /** Force a fresh run even when today's kind already has a result cached. */
  regenerate: z.boolean().default(false),
});

export class InsightsRequestDto extends zodDto(InsightsRequest) {}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class InsightJobDto {
  @ApiProperty({ enum: ["chapters", "summary", "hooks"] })
  kind!: string;

  @ApiProperty({ description: "Poll `GET /jobs/{id}` or listen for `job.completed`." })
  jobId!: string;

  @ApiProperty({ description: "True when an identical run was already queued." })
  deduplicated!: boolean;

  @ApiProperty({ description: "Tenths of a credit held for this kind." })
  tenths!: number;
}

export class InsightsAcceptedDto {
  @ApiProperty({ type: [InsightJobDto] })
  jobs!: InsightJobDto[];

  @ApiProperty({ description: "Sum of `tenths` across every kind in this request." })
  totalTenths!: number;
}

export class InsightRowDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ["chapters", "summary", "hooks"] })
  kind!: string;

  @ApiProperty({ description: '`"<id>@<n>"`, e.g. `"chapters@1"`.' })
  templateVersion!: string;

  @ApiProperty({ description: '`"anthropic"`, `"openai"` or `"mock"`.' })
  provider!: string;

  @ApiProperty({ description: "The workspace jurisdiction this call was pinned to." })
  region!: string;

  @ApiProperty({
    description:
      "Schema-validated per `kind`: ChaptersOutput | SummaryOutput | HooksOutput (@montaj/prompts).",
  })
  output!: Record<string, unknown>;

  @ApiProperty({ description: "`{inputTokens, outputTokens, costMinor, currency}`." })
  usage!: Record<string, unknown>;

  @ApiProperty()
  createdAt!: string;
}

export class InsightsResponseDto {
  @ApiProperty({ type: [InsightRowDto], description: "Most recent row per kind." })
  items!: InsightRowDto[];

  @ApiProperty({
    description:
      "Consent notice, ASCI-friendly labelling (brief §5): show verbatim next to generated content.",
  })
  disclosure!: string;
}
