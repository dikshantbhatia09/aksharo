import { z } from "zod";

export const streakCohortMetricsSchema = z.object({
  experiment: z.object({
    workspaces: z.number().int().min(0),
    /** Share still holding an active streak experiment row 4+ calendar weeks after assignment. */
    week4RetentionPct: z.number().min(0).max(100),
    /** Average publish (export/apply) events per workspace per week, this cohort. */
    avgExportsPerWeek: z.number().min(0),
  }),
  holdout: z.object({
    workspaces: z.number().int().min(0),
    week4RetentionPct: z.number().min(0).max(100),
    avgExportsPerWeek: z.number().min(0),
  }),
  generatedAt: z.string(),
});
export type StreakCohortMetrics = z.infer<typeof streakCohortMetricsSchema>;
