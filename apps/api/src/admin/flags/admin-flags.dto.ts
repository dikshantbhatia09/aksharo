import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

/**
 * `Zod: FlagTargetsSchema` — the shape `schema.prisma`'s own doc comment on
 * `feature_flags.targets` has promised since A05 and no module had yet
 * written down. Consumed today by `workspaces/entitlement.service.ts`'s
 * `flagTargets()` (allow-list only); this WP adds `excludeWorkspaceIds` —
 * the brief's "holdouts" — as a small, additive extension to that same
 * method, honoured there when the array is non-empty and otherwise a no-op
 * for every flag that predates it.
 */
export const FlagTargetsSchema = z.object({
  workspaceIds: z.array(z.string().length(26)).default([]),
  planKeys: z.array(z.string()).default([]),
  /** Workspaces excluded from this flag even if the allow-list or rollout would otherwise include them. */
  excludeWorkspaceIds: z.array(z.string().length(26)).default([]),
});
export type FlagTargets = z.infer<typeof FlagTargetsSchema>;

const CreateFlagBody = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase, digits, dot/underscore/hyphen"),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().default(false),
  rolloutPct: z.number().int().min(0).max(100).default(0),
  targets: FlagTargetsSchema.default({ workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] }),
});
export class CreateFlagDto extends zodDto(CreateFlagBody) {}

const UpdateFlagBody = z.object({
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  rolloutPct: z.number().int().min(0).max(100).optional(),
  targets: FlagTargetsSchema.optional(),
  /** Mandatory: a global flag change is exactly the kind of admin action the brief requires a reason for. */
  reason: z.string().trim().min(10).max(500),
});
export class UpdateFlagDto extends zodDto(UpdateFlagBody) {}

export class FeatureFlagDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() rolloutPct!: number;
  @ApiProperty() targets!: FlagTargets;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}
