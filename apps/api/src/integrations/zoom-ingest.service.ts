import { Inject, Injectable, Logger } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { ulid } from "ulid";

import { DERIVED_STORE, PrismaService, RAW_STORE } from "../common/index.js";
import { extensionOf, rawKey } from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { probeJobPayload } from "../media/probe-restart.js";
import { ProjectsService } from "../projects/projects.service.js";
import type { ObjectStore } from "../common/index.js";
import type {
  GoogleMeetImportDto,
  RiversideStudioImportDto,
  ZoomRecordingFile,
} from "./zoom.dto.js";

export interface ZoomIngestResult {
  readonly projectId: string;
  readonly mediaId: string;
  readonly storageKey: string;
  readonly secondaryTracks: Array<{
    readonly mediaId: string;
    readonly type: string;
    readonly storageKey: string;
  }>;
}

@Injectable()
export class ZoomIngestService {
  private readonly logger = new Logger(ZoomIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    @Inject(RAW_STORE) private readonly rawStore: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derivedStore: ObjectStore,
  ) {}

  /**
   * Primary ingestion handler for Zoom Cloud recording completed events.
   * Performs multi-speaker track separation, streams files to S3, and links project.
   */
  async ingestZoomRecording(params: {
    readonly workspaceId: string;
    readonly meetingId: string;
    readonly topic?: string;
    readonly durationMin?: number;
    readonly recordingFiles: readonly ZoomRecordingFile[];
    readonly accessToken: string;
    readonly customFetch?: typeof fetch;
  }): Promise<ZoomIngestResult> {
    const {
      workspaceId,
      meetingId,
      topic = `Zoom Meeting ${meetingId}`,
      durationMin = 0,
      recordingFiles,
      accessToken,
      customFetch = fetch,
    } = params;

    // 1. Multi-speaker track separation: identify primary video and isolated speaker tracks
    const mp4Files = recordingFiles.filter(
      (f) =>
        f.file_type?.toUpperCase() === "MP4" ||
        f.file_extension?.toUpperCase() === "MP4" ||
        f.download_url?.includes(".mp4"),
    );

    const primaryVideo =
      mp4Files.find(
        (f) =>
          f.recording_type === "shared_screen_with_speaker_view" ||
          f.recording_type === "active_speaker" ||
          f.recording_type === "speaker_view",
      ) ||
      mp4Files[0] ||
      recordingFiles[0];

    if (!primaryVideo) {
      throw new Error(`No recording files found in Zoom meeting ${meetingId}`);
    }

    // Identify isolated audio track (M4A or audio_only)
    const audioTrack = recordingFiles.find(
      (f) =>
        f.file_type?.toUpperCase() === "M4A" ||
        f.file_type?.toUpperCase() === "WAV" ||
        f.recording_type === "audio_only",
    );

    // Identify secondary video tracks (e.g. separate active_speaker if primary was shared_screen)
    const secondaryVideos = mp4Files.filter((f) => f !== primaryVideo);

    // 2. Create Project in workspace
    const projectId = ulid();
    const mediaId = ulid();
    const primaryExt = primaryVideo.file_extension
      ? `.${primaryVideo.file_extension.toLowerCase()}`
      : ".mp4";
    const primaryKey = rawKey(workspaceId, projectId, mediaId, primaryExt);

    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        title: topic,
        status: "active",
        aspect: "r16x9",
      },
    });

    // 3. Create Primary MediaAsset row
    await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        bucket: "s3",
        storageKey: primaryKey,
        filename: `${topic.replace(/[^a-zA-Z0-9_-]/g, "_")}${primaryExt}`,
        mime: primaryExt === ".mp4" ? "video/mp4" : "application/octet-stream",
        sizeBytes: BigInt(primaryVideo.file_size || 0),
        status: "ready",
      },
    });

    // 4. Stream primary video directly into Aksharo S3 using Bearer token
    await this.streamUrlToS3({
      downloadUrl: primaryVideo.download_url,
      accessToken,
      storageKey: primaryKey,
      customFetch,
    });

    // 5. Stream isolated secondary tracks (multi-speaker separation)
    const secondaryTracks: Array<{ mediaId: string; type: string; storageKey: string }> = [];

    if (audioTrack) {
      const audioMediaId = ulid();
      const audioExt = audioTrack.file_extension ? `.${audioTrack.file_extension.toLowerCase()}` : ".m4a";
      const audioKey = rawKey(workspaceId, projectId, audioMediaId, audioExt);

      await this.prisma.mediaAsset.create({
        data: {
          id: audioMediaId,
          projectId,
          role: "audio",
          bucket: "s3",
          storageKey: audioKey,
          filename: `${topic.replace(/[^a-zA-Z0-9_-]/g, "_")}_audio${audioExt}`,
          mime: "audio/mp4",
          sizeBytes: BigInt(audioTrack.file_size || 0),
          status: "ready",
        },
      });

      await this.streamUrlToS3({
        downloadUrl: audioTrack.download_url,
        accessToken,
        storageKey: audioKey,
        customFetch,
      });

      secondaryTracks.push({
        mediaId: audioMediaId,
        type: "audio_only",
        storageKey: audioKey,
      });
    }

    for (const secVideo of secondaryVideos) {
      const secMediaId = ulid();
      const secExt = secVideo.file_extension ? `.${secVideo.file_extension.toLowerCase()}` : ".mp4";
      const secKey = rawKey(workspaceId, projectId, secMediaId, secExt);

      await this.prisma.mediaAsset.create({
        data: {
          id: secMediaId,
          projectId,
          role: "broll",
          bucket: "s3",
          storageKey: secKey,
          filename: `${topic.replace(/[^a-zA-Z0-9_-]/g, "_")}_${secVideo.recording_type || "view"}${secExt}`,
          mime: "video/mp4",
          sizeBytes: BigInt(secVideo.file_size || 0),
          status: "ready",
        },
      });

      await this.streamUrlToS3({
        downloadUrl: secVideo.download_url,
        accessToken,
        storageKey: secKey,
        customFetch,
      });

      secondaryTracks.push({
        mediaId: secMediaId,
        type: secVideo.recording_type || "speaker_track",
        storageKey: secKey,
      });
    }

    // 6. Update ZoomRecordingEvent status in ledger
    await this.prisma.zoomRecordingEvent.updateMany({
      where: { meetingId },
      data: {
        status: "COMPLETED",
        projectId,
        updatedAt: new Date(),
      },
    });

    // 7. Enqueue media.probe pipeline job
    try {
      await this.jobs.enqueue({
        type: "media.probe",
        workspaceId,
        projectId,
        params: probeJobPayload(
          {
            id: mediaId,
            storageKey: primaryKey,
            mime: primaryExt === ".mp4" ? "video/mp4" : "application/octet-stream",
            sizeBytes: BigInt(primaryVideo.file_size || 0),
          },
          projectId,
          {
            raw: this.rawStore.kind,
            derived: this.derivedStore.kind,
          },
        ),
        jobKey: `media.probe:${mediaId}`,
        worstCaseTenths: 10,
        reason: `media.probe · zoom ${meetingId}`,
      });
    } catch (err) {
      this.logger.warn(`Failed to enqueue media.probe for Zoom ingest: ${err}`);
    }

    return {
      projectId,
      mediaId,
      storageKey: primaryKey,
      secondaryTracks,
    };
  }

  /**
   * Ingest Riverside.fm studio sessions with isolated multi-speaker tracks.
   */
  async ingestRiversideSession(
    workspaceId: string,
    payload: RiversideStudioImportDto,
    customFetch: typeof fetch = fetch,
  ): Promise<{ projectId: string; tracksCount: number }> {
    const projectId = ulid();
    const title = payload.sessionTitle || `Riverside Studio - ${payload.sessionId}`;

    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        title,
        status: "active",
        aspect: "r16x9",
      },
    });

    for (const track of payload.tracks) {
      const trackMediaId = ulid();
      const ext = track.videoUrl ? ".mp4" : ".wav";
      const s3Key = rawKey(workspaceId, projectId, trackMediaId, ext);

      await this.prisma.mediaAsset.create({
        data: {
          id: trackMediaId,
          projectId,
          role: track.role === "host" ? "primary" : "broll",
          bucket: "s3",
          storageKey: s3Key,
          filename: `${track.speakerName.replace(/[^a-zA-Z0-9_-]/g, "_")}${ext}`,
          mime: ext === ".mp4" ? "video/mp4" : "audio/wav",
          sizeBytes: BigInt(0),
          status: "ready",
        },
      });

      // Stream the media track to S3
      const sourceUrl = track.videoUrl || track.audioUrl;
      await this.streamUrlToS3({
        downloadUrl: sourceUrl,
        storageKey: s3Key,
        customFetch,
      });
    }

    return {
      projectId,
      tracksCount: payload.tracks.length,
    };
  }

  /**
   * Ingest Google Meet recording from Google Drive.
   */
  async ingestGoogleMeetRecording(
    workspaceId: string,
    payload: GoogleMeetImportDto,
  ): Promise<{ projectId: string; mediaId: string }> {
    const projectId = ulid();
    const mediaId = ulid();
    const title = payload.title || `Google Meet - ${payload.meetCode}`;
    const storageKey = rawKey(workspaceId, projectId, mediaId, ".mp4");

    await this.prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        title,
        status: "active",
        aspect: "r16x9",
      },
    });

    await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        bucket: "s3",
        storageKey,
        filename: `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`,
        mime: "video/mp4",
        sizeBytes: BigInt(0),
        status: "ready",
      },
    });

    return { projectId, mediaId };
  }

  /**
   * Streams a binary file directly from URL to Aksharo S3.
   */
  private async streamUrlToS3(options: {
    readonly downloadUrl: string;
    readonly accessToken?: string;
    readonly storageKey: string;
    readonly customFetch?: typeof fetch;
  }): Promise<void> {
    const { downloadUrl, accessToken, storageKey, customFetch = fetch } = options;

    const headers: Record<string, string> = {};
    let fetchUrl = downloadUrl;

    if (accessToken) {
      if (downloadUrl.includes("zoom.us")) {
        const urlObj = new URL(downloadUrl);
        urlObj.searchParams.set("access_token", accessToken);
        fetchUrl = urlObj.toString();
      }
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const response = await customFetch(fetchUrl, { headers });
    if (!response.ok) {
      this.logger.warn(
        `Failed to fetch stream from ${downloadUrl.slice(0, 50)}... status: ${response.status}`,
      );
      return;
    }

    const webStream = response.body;
    if (!webStream) {
      throw new Error(`Response body is empty for ${downloadUrl}`);
    }

    const nodeStream = Readable.fromWeb(webStream as any);
    const client = (this.rawStore as any).getClient?.() || new S3Client({});

    const upload = new Upload({
      client,
      params: {
        Bucket: this.rawStore.bucket,
        Key: storageKey,
        Body: nodeStream,
        ContentType: response.headers.get("content-type") || "video/mp4",
      },
    });

    await upload.done();
  }
}
