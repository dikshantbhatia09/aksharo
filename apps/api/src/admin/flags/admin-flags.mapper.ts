import { FlagTargetsSchema } from "./admin-flags.dto.js";

import type { FeatureFlagDto } from "./admin-flags.dto.js";
import type { FeatureFlag } from "@prisma/client";

export function toFeatureFlagDto(row: FeatureFlag): FeatureFlagDto {
  const parsedTargets = FlagTargetsSchema.safeParse(row.targets);
  return {
    id: row.id,
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    rolloutPct: row.rolloutPct,
    targets: parsedTargets.success
      ? parsedTargets.data
      : { workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] },
    updatedAt: row.updatedAt.toISOString(),
  };
}
