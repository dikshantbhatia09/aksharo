import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const PublishStyleBody = z.object({
  published: z.boolean(),
  reason: z.string().trim().min(10).max(500),
});
export class PublishStyleDto extends zodDto(PublishStyleBody) {}

export class AdminStylePresetDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() workspaceId?: string | null;
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() category!: string;
  @ApiProperty() published!: boolean;
  @ApiProperty() minPlan!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ description: "A18a parity gate result (D33)." })
  parity!: {
    assRenderable: boolean;
    assExportable: boolean;
    requiresLayoutMetrics: boolean;
    parityScore: number | null;
  };
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}
