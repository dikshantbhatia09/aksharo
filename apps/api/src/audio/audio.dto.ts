import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/audio/*` (B10).
 *
 * Requests are Zod (validated by the global pipe); responses are classes so
 * `pnpm gen:client` has decorator metadata to read from — the split
 * `transcripts.dto.ts` documents and this module repeats for the same reason.
 */

const CleanRequest = z.object({
  strength: z.enum(["light", "medium", "strong"]).default("medium"),
  target: z.enum(["social", "youtube", "podcast"]).default("social"),
  dereverb: z.boolean().optional(),
  deesser: z.boolean().optional(),
  /** Which media asset to clean; omitted means the project's primary media. */
  mediaId: z.string().trim().min(1).optional(),
});

export class CleanRequestDto extends zodDto(CleanRequest) {}

const CleanListQuery = z.object({
  mediaId: z.string().trim().min(1).optional(),
});

export class CleanListQueryDto extends zodDto(CleanListQuery) {}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class AudioCleanQuoteDto {
  @ApiProperty({ description: "Credits held before the job was enqueued, in tenths." })
  tenths!: number;

  @ApiProperty({ description: '"1.2" — for display only, never for arithmetic.' })
  credits!: string;

  @ApiProperty({ description: "Media duration the quote was computed from." })
  durationMs!: number;
}

export class CleanAcceptedDto {
  @ApiProperty({ description: "Poll `GET /jobs/{id}` or listen for `job.completed`." })
  jobId!: string;

  @ApiProperty({ description: "The `audio_cleans` row this run will write to." })
  cleanId!: string;

  @ApiProperty({ description: "`queued` on a fresh accept." })
  status!: string;

  @ApiProperty({ description: "True when an identical live run already existed." })
  deduplicated!: boolean;

  @ApiProperty({ type: AudioCleanQuoteDto })
  quote!: AudioCleanQuoteDto;
}

export class AudioCleanMetricsDto {
  @ApiPropertyOptional({ description: "Approximate LUFS before cleaning." })
  inputLufs?: number;

  @ApiPropertyOptional({ description: "Approximate LUFS after cleaning and normalising." })
  outputLufs?: number;

  @ApiPropertyOptional({ description: "Estimated noise-floor reduction, dB." })
  snrGainDb?: number;

  @ApiPropertyOptional({ description: "Samples at or beyond full scale in the output." })
  clippingCount?: number;

  @ApiPropertyOptional({ description: "Peak true level of the output, dBTP." })
  truePeakDbtp?: number;
}

export class AudioCleanDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() mediaId!: string;
  @ApiProperty({ enum: ["light", "medium", "strong"] }) strength!: string;
  @ApiProperty({ enum: ["social", "youtube", "podcast"] }) target!: string;
  @ApiProperty() dereverb!: boolean;
  @ApiProperty() deesser!: boolean;
  @ApiProperty({ enum: ["queued", "running", "succeeded", "failed"] }) status!: string;
  @ApiPropertyOptional() jobId?: string;
  @ApiPropertyOptional({ type: AudioCleanMetricsDto })
  metrics?: AudioCleanMetricsDto;
  @ApiPropertyOptional({
    description: "Signed GET URL for the cleaned 48 kHz WAV, when succeeded.",
  })
  cleanedAudioUrl?: string;
  @ApiPropertyOptional({ description: "Signed GET URL for the original-track A/B preview clip." })
  previewOriginalUrl?: string;
  @ApiPropertyOptional({ description: "Signed GET URL for the cleaned-track A/B preview clip." })
  previewCleanedUrl?: string;
  @ApiPropertyOptional() failureReason?: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() completedAt?: string;
}

export class AudioCleanListDto {
  @ApiProperty({ type: [AudioCleanDto] })
  cleans!: AudioCleanDto[];
}
