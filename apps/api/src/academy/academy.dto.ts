import { z } from "zod";

import { zodDto } from "../common/index.js";

export const markStepDoneSchema = z.object({
  trackId: z.string().min(1).max(64),
  stepId: z.string().min(1).max(64),
});
export type MarkStepDoneInput = z.infer<typeof markStepDoneSchema>;
export class MarkStepDoneDto extends zodDto(markStepDoneSchema) {}

export const dismissChangelogSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type DismissChangelogInput = z.infer<typeof dismissChangelogSchema>;
export class DismissChangelogDto extends zodDto(dismissChangelogSchema) {}

export const academyStepProgressSchema = z.object({
  stepId: z.string(),
  completedAt: z.string(),
  source: z.enum(["manual", "event"]),
});

export const academyTrackProgressSchema = z.object({
  trackId: z.string(),
  completedStepIds: z.array(z.string()),
  totalSteps: z.number().int(),
  rewardGranted: z.boolean(),
  rewardTenths: z.number().int(),
});
export type AcademyTrackProgress = z.infer<typeof academyTrackProgressSchema>;

export const academyProgressResponseSchema = z.object({
  tracks: z.array(academyTrackProgressSchema),
  lifetimeGrantedTenths: z.number().int(),
  lifetimeCapTenths: z.number().int(),
});
export type AcademyProgressResponse = z.infer<typeof academyProgressResponseSchema>;

export const markStepDoneResultSchema = z.object({
  trackId: z.string(),
  stepId: z.string(),
  alreadyDone: z.boolean(),
  trackCompleted: z.boolean(),
  rewardGranted: z.boolean(),
});
export type MarkStepDoneResult = z.infer<typeof markStepDoneResultSchema>;

export const changelogDismissedResponseSchema = z.object({
  dismissedVersion: z.string().nullable(),
});
export type ChangelogDismissedResponse = z.infer<typeof changelogDismissedResponseSchema>;
