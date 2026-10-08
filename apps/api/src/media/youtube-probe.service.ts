import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  type YouTubeProbeResponse,
  YouTubeProbeResponseSchema,
} from "@montaj/repurpose-contracts";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";

const execFileAsync = promisify(execFile);

export const YOUTUBE_URL_REGEX =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

@Injectable()
export class YouTubeProbeService {
  private readonly logger = new Logger(YouTubeProbeService.name);

  async probe(rawUrl: string): Promise<YouTubeProbeResponse> {
    const trimmed = rawUrl.trim();
    const match = YOUTUBE_URL_REGEX.exec(trimmed);
    if (!match) {
      throw new AppException(
        ERROR_CODES.badRequest,
        "Invalid or unsupported YouTube URL format.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const videoId = match[1] as string;
    const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const ytDlpBinary = process.env["YT_DLP_PATH"] || "yt-dlp";

    const proxy =
      process.env["BRIGHT_DATA_PROXY_URL"] ||
      process.env["WEBSHARE_PROXY_URL"] ||
      process.env["YT_DLP_PROXY"] ||
      "";

    const args = [
      "--no-colors",
      "--encoding",
      "utf-8",
      "--no-playlist",
      "--ignore-config",
      "--no-cache-dir",
      "--extractor-args",
      "youtube:player_client=ios,android,web",
      "--skip-download",
      "--dump-single-json",
      "--socket-timeout",
      "15",
    ];

    if (proxy.trim()) {
      args.push("--proxy", proxy.trim());
    }

    args.push("--", normalizedUrl);

    try {
      const { stdout } = await execFileAsync(ytDlpBinary, args, {
        timeout: 20_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parsed = JSON.parse(stdout);
      const rawChapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
      const nativeChapters: Array<{ title: string; startSec: number; endSec: number }> = [];

      for (const item of rawChapters) {
        if (typeof item === "object" && item !== null) {
          const title = typeof item.title === "string" ? item.title.trim() : "";
          const startSec = typeof item.start_time === "number" ? item.start_time : undefined;
          const endSec = typeof item.end_time === "number" ? item.end_time : undefined;
          if (title && startSec !== undefined && endSec !== undefined && endSec > startSec) {
            nativeChapters.push({ title, startSec, endSec });
          }
        }
      }

      const response: YouTubeProbeResponse = {
        videoId: (parsed.id as string) || videoId,
        title: (parsed.title as string) || "Untitled Video",
        channelName: (parsed.channel as string) || (parsed.uploader as string) || "YouTube Channel",
        durationSec: typeof parsed.duration === "number" && Number.isFinite(parsed.duration) ? parsed.duration : 0,
        thumbnailUrl:
          (parsed.thumbnail as string) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isLiveStream: Boolean(
          parsed.is_live === true ||
          parsed.live_status === "is_live" ||
          parsed.live_status === "is_upcoming",
        ),
        hasCaptions: Boolean(parsed.subtitles && Object.keys(parsed.subtitles).length > 0),
        nativeChapters,
      };

      return YouTubeProbeResponseSchema.parse(response);
    } catch (err: unknown) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ url: normalizedUrl, error: message }, "Failed to probe YouTube URL");

      if (message.toLowerCase().includes("private video") || message.toLowerCase().includes("sign in")) {
        throw new AppException(
          ERROR_CODES.badRequest,
          "This YouTube video is private or requires sign-in.",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (message.toLowerCase().includes("not available") || message.toLowerCase().includes("404")) {
        throw new AppException(
          ERROR_CODES.notFound,
          "This YouTube video is unavailable or was removed.",
          HttpStatus.NOT_FOUND,
        );
      }

      throw new AppException(
        ERROR_CODES.unavailable,
        "Could not retrieve YouTube video metadata. Please try again.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

