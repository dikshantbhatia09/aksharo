import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request/response shapes for `/projects/{id}/prompted-edits` (D07).
 * Requests are Zod (global pipe); responses are classes (`pnpm gen:client`),
 * same split `insights.dto.ts` makes.
 */
const CreatePlanRequest = z.object({
  prompt: z.string().min(1).max(2_000),
  engine: z.enum(["flash", "pro"]).default("flash"),
});
export class CreatePlanRequestDto extends zodDto(CreatePlanRequest) {}

export class EditPlanPassDto {
  @ApiProperty({ enum: ["autocut", "zoom", "reframe", "sfx", "music", "textfx"] })
  kind!: string;

  @ApiProperty({ description: "Kind-specific params (preset, aspect, engine, ...)." })
  params!: Record<string, unknown>;
}

export class PromptedEditPlanDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  prompt!: string;

  @ApiProperty({ enum: ["flash", "pro"] })
  engine!: string;

  @ApiProperty({ type: [EditPlanPassDto] })
  passes!: EditPlanPassDto[];

  @ApiProperty({ required: false })
  style?: string;

  @ApiProperty({ required: false, enum: ["roman", "native", "translated"] })
  script?: string;

  @ApiProperty({ type: [String] })
  rationale!: string[];

  @ApiProperty({ enum: ["planned", "running", "completed", "failed"] })
  status!: string;

  @ApiProperty({ description: "Tenths of a credit this plan would hold at `run()`." })
  holdTenths!: number;

  @ApiProperty({ description: 'Presentation string, e.g. "3.0".' })
  holdCredits!: string;

  @ApiProperty({
    required: false,
    description: "Tenths of a credit actually settled, once completed.",
  })
  settledTenths?: number;

  @ApiProperty()
  createdAt!: string;
}

export class RunPlanAcceptedDto {
  @ApiProperty()
  planId!: string;

  @ApiProperty()
  jobId!: string;

  @ApiProperty({ description: "The first pass kind enqueued; the rest chain from its completion." })
  firstPassKind!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  holdTenths!: number;

  @ApiProperty()
  holdCredits!: string;
}
