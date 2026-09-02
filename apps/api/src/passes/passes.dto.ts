import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { AUTOCUT_PRESETS, REFRAME_ASPECTS, ZOOM_PRESETS } from "./passes.errors.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/passes*` (B18).
 *
 * **Requests** are Zod, validated by the global pipe, matching
 * `transcripts.dto.ts`'s own split. **Responses** are classes (`pnpm gen:client`
 * reads decorator metadata off them); `Pass`/`PassItem` are declared as opaque
 * `Object`, the same way `edg.dto.ts`'s `PassListDto` does, because the
 * generated client re-exports those frozen `@montaj/edg` types rather than
 * carrying a second copy of a CONTRACTS §2 shape.
 */

/** Overrides on a preset's own thresholds — every field optional, all bounded. */
const AutocutOptions = z.object({
  minSilenceMs: z.number().int().min(100).max(10_000).optional(),
  paddingMs: z.number().int().min(0).max(500).optional(),
  maxRemovalRatio: z.number().min(0).max(0.95).optional(),
});

const StartAutocutRequest = z.object({
  preset: z.enum(AUTOCUT_PRESETS).default("standard"),
  options: AutocutOptions.optional(),
});

export class StartAutocutRequestDto extends zodDto(StartAutocutRequest) {}

/** Overrides on the reframe crop's own thresholds (B19 §4) — all optional, all bounded. */
const ReframeOptions = z.object({
  deadzoneFraction: z.number().min(0).max(0.5).optional(),
  maxVelocityPerS: z.number().gt(0).max(5).optional(),
});

const StartZoomRequest = z.object({
  preset: z.enum(ZOOM_PRESETS).default("standard"),
});

export class StartZoomRequestDto extends zodDto(StartZoomRequest) {}

const StartReframeRequest = z.object({
  aspect: z.enum(REFRAME_ASPECTS).default("9:16"),
  options: ReframeOptions.optional(),
});

export class StartReframeRequestDto extends zodDto(StartReframeRequest) {}

export class PassAcceptedDto {
  @ApiProperty({
    description: "The `ai.pass` job id; poll `GET /jobs/{id}` or watch `job.completed`.",
  })
  jobId!: string;

  @ApiProperty({ description: "The pass id `MergePass` will land under once the job completes." })
  passId!: string;

  @ApiProperty({ description: "The enqueued job's status, e.g. `queued`." })
  status!: string;

  @ApiProperty({
    description: "True when an autocut for this project was already queued or running.",
  })
  deduplicated!: boolean;

  @ApiProperty()
  quote!: { tenths: number; credits: string; durationMs: number };
}

export class PassSummaryListDto {
  @ApiProperty({
    type: [Object],
    description: "`Pass[]` from `@montaj/edg`, each with its `items`.",
  })
  passes!: unknown[];
}
