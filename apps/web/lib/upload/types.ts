import type { UploadProgressState } from "./multipart-upload";

/** What the Home drop zone and the upload tray render per file. */
export type UploadStatus =
  | "hashing"
  | "creating-project"
  | "uploading"
  | "paused"
  | "completing"
  | "transcribing"
  | "ready"
  | "duplicate"
  | "error"
  | "cancelled";

export interface UploadQuickPick {
  readonly language: string;
  readonly styleId?: string;
  readonly aspect: "9:16" | "16:9" | "1:1" | "4:5";
}

export interface UploadItemState {
  readonly id: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly status: UploadStatus;
  readonly progress: UploadProgressState;
  readonly projectId?: string;
  readonly mediaId?: string;
  /** Set on `status: "duplicate"` — the project the existing media already lives in. */
  readonly duplicateOfProjectId?: string;
  readonly jobId?: string;
  readonly error?: string;
}
