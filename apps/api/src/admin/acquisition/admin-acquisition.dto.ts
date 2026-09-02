import { z } from "zod";

export const acquisitionBreakdownRowSchema = z.object({
  key: z.string(),
  count: z.number().int().min(0),
});

export const acquisitionMetricsSchema = z.object({
  windowDays: z.number().int().min(1),
  totalOnboardingCompleted: z.number().int().min(0),
  bySource: z.array(acquisitionBreakdownRowSchema),
  byCodeType: z.array(acquisitionBreakdownRowSchema),
  generatedAt: z.string(),
});
export type AcquisitionMetrics = z.infer<typeof acquisitionMetricsSchema>;
