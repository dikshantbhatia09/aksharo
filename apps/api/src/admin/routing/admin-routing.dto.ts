import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const SetRoutingWeightBody = z.object({
  laneId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase, digits, hyphen — matches a routing.yaml lane id"),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "the registry name in worker_ai/providers/registry.py"),
  weight: z.number().int().min(0).max(100),
  reason: z.string().trim().min(10).max(500),
});
export class SetRoutingWeightDto extends zodDto(SetRoutingWeightBody) {}

export class RoutingWeightOverrideDto {
  @ApiProperty() id!: string;
  @ApiProperty() laneId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() weight!: number;
  @ApiProperty() updatedBy!: string;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}
