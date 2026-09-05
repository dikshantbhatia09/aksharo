import type { UploadProgressState } from "./multipart-upload";

/** What the Home drop zone and the upload tray render per file. */
export type UploadStatus =
  | "hashing"
  | "creating-project"
  | "uploading"
  | "paused"
  | "completing"
  // The server pipeline owns what happens after the upload: probe, proxy and
  // the auto-started transcription. The tray reports that instead of claiming
  // a "ready" it cannot know (FIX-03).
  | "processing"
  | "transcribing"
  | "ready"
  | "duplicate"
  | "error"
  | "cancelled";

export interface UploadQuickPick {
  /**
   * The spoken language, BCP-47. Optional on purpose (FIX-04): the Home
   * picker starts empty and only an explicit gesture fills it, so every
   * consumer has to decide what it does with "not chosen" rather than
   * inheriting a default that spends credits on the wrong lane.
   */
  readonly language?: string;
  /**
   * Every language the onboarding wizard recorded (F-002 "Languages you
   * speak on camera"), primary first — carried into the transcribe request
   * as routing hints (B17). Optional: the resumable-upload path has no
   * profile to read this from.
   */
  readonly languages?: readonly string[];
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
