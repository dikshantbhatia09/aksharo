import { Readable } from "node:stream";
import { uploadStreamToS3 } from "../cloud/s3-stream-uploader.js";
import { logger } from "../logger.js";
import type { S3Client } from "@aws-sdk/client-s3";

export interface ZoomRecordingFileDescriptor {
  readonly id?: string;
  readonly meeting_id?: string;
  readonly file_type?: string;
  readonly file_extension?: string;
  readonly file_size?: number;
  readonly recording_type?: string;
  readonly download_url: string;
  readonly status?: string;
}

export interface ZoomIngestPlan {
  readonly primaryVideo: ZoomRecordingFileDescriptor;
  readonly audioOnly?: ZoomRecordingFileDescriptor;
  readonly secondaryTracks: ZoomRecordingFileDescriptor[];
}

export interface ZoomIngestJobPayload {
  readonly workspaceId: string;
  readonly meetingId: string;
  readonly topic?: string;
  readonly recordingFiles: readonly ZoomRecordingFileDescriptor[];
  readonly accessToken: string;
}

export interface ZoomIngestOutput {
  readonly meetingId: string;
  readonly primaryVideoKey: string;
  readonly audioOnlyKey?: string;
  readonly secondaryTrackKeys: string[];
  readonly totalBytes: number;
}

/**
 * Plan track extraction from Zoom cloud recording files:
 * 1. Selects primary video (shared_screen_with_speaker_view > active_speaker > speaker_view > first MP4)
 * 2. Selects isolated audio track (audio_only or M4A)
 * 3. Identifies multi-speaker isolated tracks for track separation
 */
export function planZoomIngest(
  recordingFiles: readonly ZoomRecordingFileDescriptor[],
): ZoomIngestPlan {
  if (!recordingFiles || recordingFiles.length === 0) {
    throw new Error("No recording files provided to Zoom ingest processor");
  }

  const mp4Files = recordingFiles.filter(
    (f) =>
      f.file_type?.toUpperCase() === "MP4" ||
      f.file_extension?.toUpperCase() === "MP4" ||
      f.download_url.includes(".mp4"),
  );

  const primaryVideo =
    mp4Files.find((f) => f.recording_type === "shared_screen_with_speaker_view") ||
    mp4Files.find((f) => f.recording_type === "active_speaker") ||
    mp4Files.find((f) => f.recording_type === "speaker_view") ||
    mp4Files[0] ||
    recordingFiles[0]!;

  const audioOnly = recordingFiles.find(
    (f) =>
      f.recording_type === "audio_only" ||
      f.file_type?.toUpperCase() === "M4A" ||
      f.file_type?.toUpperCase() === "WAV",
  );

  const secondaryTracks = mp4Files.filter((f) => f !== primaryVideo);

  return {
    primaryVideo,
    audioOnly,
    secondaryTracks,
  };
}

/**
 * Streams a remote file to S3 using Bearer token authentication.
 */
export async function streamZoomFileToS3(options: {
  readonly s3Client: S3Client;
  readonly bucket: string;
  readonly storageKey: string;
  readonly downloadUrl: string;
  readonly accessToken?: string;
  readonly customFetch?: typeof fetch;
}): Promise<number> {
  const { s3Client, bucket, storageKey, downloadUrl, accessToken, customFetch = fetch } = options;

  let url = downloadUrl;
  const headers: Record<string, string> = {};

  if (accessToken) {
    if (downloadUrl.includes("zoom.us")) {
      const urlObj = new URL(downloadUrl);
      urlObj.searchParams.set("access_token", accessToken);
      url = urlObj.toString();
    }
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await customFetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to download Zoom recording file from ${url.slice(0, 60)}: status ${response.status}`,
    );
  }

  const webStream = response.body;
  if (!webStream) {
    throw new Error(`Empty body returned from Zoom for ${url}`);
  }

  const nodeStream = Readable.fromWeb(webStream as any);
  const result = await uploadStreamToS3({
    client: s3Client,
    bucket,
    key: storageKey,
    stream: nodeStream,
    contentType: response.headers.get("content-type") || "video/mp4",
  });

  return result.totalBytesUploaded;
}

/**
 * Worker processor for Zoom recording ingestion.
 */
export async function processZoomIngest(
  payload: ZoomIngestJobPayload,
  deps: {
    readonly s3Client: S3Client;
    readonly bucket: string;
    readonly keyPrefix: string;
    readonly customFetch?: typeof fetch;
  },
): Promise<ZoomIngestOutput> {
  const { workspaceId, meetingId, recordingFiles, accessToken } = payload;
  const { s3Client, bucket, keyPrefix, customFetch = fetch } = deps;

  const plan = planZoomIngest(recordingFiles);
  let totalBytes = 0;

  // 1. Stream primary video
  const primaryVideoKey = `${keyPrefix}/${meetingId}/primary.mp4`;
  logger.info(`[zoom-ingest] Streaming primary video to ${primaryVideoKey}`);
  const primaryBytes = await streamZoomFileToS3({
    s3Client,
    bucket,
    storageKey: primaryVideoKey,
    downloadUrl: plan.primaryVideo.download_url,
    accessToken,
    customFetch,
  });
  totalBytes += primaryBytes;

  // 2. Stream audio track if available
  let audioOnlyKey: string | undefined;
  if (plan.audioOnly) {
    audioOnlyKey = `${keyPrefix}/${meetingId}/audio.m4a`;
    logger.info(`[zoom-ingest] Streaming isolated audio track to ${audioOnlyKey}`);
    const audioBytes = await streamZoomFileToS3({
      s3Client,
      bucket,
      storageKey: audioOnlyKey,
      downloadUrl: plan.audioOnly.download_url,
      accessToken,
      customFetch,
    });
    totalBytes += audioBytes;
  }

  // 3. Stream secondary multi-speaker tracks if available
  const secondaryTrackKeys: string[] = [];
  for (let i = 0; i < plan.secondaryTracks.length; i++) {
    const sec = plan.secondaryTracks[i]!;
    const secKey = `${keyPrefix}/${meetingId}/speaker_${i + 1}.mp4`;
    logger.info(`[zoom-ingest] Streaming secondary speaker track to ${secKey}`);
    const secBytes = await streamZoomFileToS3({
      s3Client,
      bucket,
      storageKey: secKey,
      downloadUrl: sec.download_url,
      accessToken,
      customFetch,
    });
    totalBytes += secBytes;
    secondaryTrackKeys.push(secKey);
  }

  return {
    meetingId,
    primaryVideoKey,
    audioOnlyKey,
    secondaryTrackKeys,
    totalBytes,
  };
}

