import { z } from "zod";

export const zoomAuthorizeUrlResponseSchema = z.object({
  url: z.string().url(),
  state: z.string(),
});
export type ZoomAuthorizeUrlResponseDto = z.infer<typeof zoomAuthorizeUrlResponseSchema>;

export const zoomOAuthCallbackSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url().optional(),
});
export type ZoomOAuthCallbackDto = z.infer<typeof zoomOAuthCallbackSchema>;

export const workspaceZoomIntegrationViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  zoomUserId: z.string(),
  zoomEmail: z.string().email(),
  autoRepurpose: z.boolean(),
  minDurationSec: z.number().int().nonnegative(),
  nameFilter: z.string().nullable().optional(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceZoomIntegrationViewDto = z.infer<typeof workspaceZoomIntegrationViewSchema>;

export const updateZoomSettingsSchema = z.object({
  autoRepurpose: z.boolean().optional(),
  minDurationSec: z.number().int().min(0).max(86400).optional(),
  nameFilter: z.string().max(255).nullable().optional(),
});
export type UpdateZoomSettingsDto = z.infer<typeof updateZoomSettingsSchema>;

export const zoomRecordingEventViewSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  workspaceId: z.string().nullable().optional(),
  topic: z.string(),
  durationMin: z.number().int(),
  fileCount: z.number().int(),
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "IGNORED", "FAILED"]),
  projectId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ZoomRecordingEventViewDto = z.infer<typeof zoomRecordingEventViewSchema>;

export const manualZoomImportSchema = z.object({
  meetingId: z.string().min(1),
  topic: z.string().optional(),
  downloadUrl: z.string().url().optional(),
});
export type ManualZoomImportDto = z.infer<typeof manualZoomImportSchema>;

export const riversideStudioImportSchema = z.object({
  sessionId: z.string().min(1),
  sessionTitle: z.string().optional(),
  tracks: z.array(
    z.object({
      speakerName: z.string(),
      role: z.enum(["host", "guest", "screen", "combined"]).default("host"),
      videoUrl: z.string().url().optional(),
      audioUrl: z.string().url(),
      durationSec: z.number().positive().optional(),
    }),
  ).min(1),
});
export type RiversideStudioImportDto = z.infer<typeof riversideStudioImportSchema>;

export const googleMeetImportSchema = z.object({
  meetCode: z.string().min(1),
  recordingFileId: z.string().min(1),
  title: z.string().optional(),
});
export type GoogleMeetImportDto = z.infer<typeof googleMeetImportSchema>;

export interface ZoomRecordingFile {
  readonly id?: string;
  readonly meeting_id?: string;
  readonly file_type?: string;
  readonly file_extension?: string;
  readonly file_size?: number;
  readonly recording_type?: string;
  readonly download_url: string;
  readonly status?: string;
  readonly recording_start?: string;
  readonly recording_end?: string;
}

export interface ZoomWebhookPayload {
  readonly event: string;
  readonly payload?: {
    readonly plainToken?: string;
    readonly account_id?: string;
    readonly object?: {
      readonly id: string | number;
      readonly uuid?: string;
      readonly host_id?: string;
      readonly topic?: string;
      readonly start_time?: string;
      readonly duration?: number; // duration in minutes
      readonly total_size?: number;
      readonly recording_count?: number;
      readonly recording_files?: ZoomRecordingFile[];
    };
  };
  readonly download_token?: string;
}

