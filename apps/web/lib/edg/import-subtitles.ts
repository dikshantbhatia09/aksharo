"use client";

/**
 * S-03: client for the (previously caller-less) subtitle import route.
 *
 * `POST /projects/{projectId}/import` has existed and been fully implemented
 * since the media package landed — `@Controller("projects/:projectId")`
 * (`apps/api/src/media/media.controller.ts:66`) + `@Post("import")` (line 183)
 * — and a sweep of `apps/web` found nothing calling it. This file is the seam
 * that ends that. `defineEndpoint` is `@montaj/api-client`'s documented escape
 * hatch for a route the curated hooks don't cover (same pattern as
 * `transcription-state.ts`).
 *
 * Every name below is copied from the server's own schema, not guessed:
 * `importSubtitlesSchema` at `apps/api/src/media/media.dto.ts:64` and
 * `importResultSchema` at line 158.
 */
import { defineEndpoint } from "@montaj/api-client";

/** The four kinds the parsers accept (`media/import/subtitle-parsers.ts:21`). */
export const SUBTITLE_KINDS = ["srt", "vtt", "ass", "txt"] as const;

export type SubtitleKind = (typeof SUBTITLE_KINDS)[number];

/** `importSubtitlesSchema`, field for field (`media.dto.ts:65-70`). */
export interface ImportSubtitlesBody {
  /** `kind: z.enum(SUBTITLE_KINDS)` — required; there is no `filename` field. */
  readonly kind: SubtitleKind;
  /** `content: z.string().min(1).max(IMPORT_MAX_BYTES)` — the file, as text. */
  readonly content: string;
  /** `language: z.string().trim().min(2).max(16).optional()` — BCP-47. */
  readonly language?: string;
  /** `mediaId: ulidSchema.optional()` — attach to a non-primary media item. */
  readonly mediaId?: string;
}

/** `importResultSchema` / `ImportResult` (`media.dto.ts:158-168`). */
export interface ImportSubtitlesResult {
  readonly mediaId: string;
  readonly kind: SubtitleKind;
  readonly key: string;
  readonly cueCount: number;
  /** False for `txt`: no timings to trust, only text to align. */
  readonly timed: boolean;
  readonly warnings: readonly string[];
  /** The `ai.align` job the import enqueued — the one this screen waits on. */
  readonly jobId: string;
}

export const importSubtitles = defineEndpoint<ImportSubtitlesBody, ImportSubtitlesResult>({
  method: "POST",
  path: "/projects/{projectId}/import",
  auth: "bearer",
});

export const SUBTITLE_ACCEPT = ".srt,.vtt,.ass,.txt";
/** Mirrors `IMPORT_MAX_BYTES` (`apps/api/src/projects/projects.constants.ts:68`). */
export const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024; // parser input, not media — keep it honest

/**
 * The `kind` discriminator the schema wants, read off the filename.
 *
 * The server takes `kind`, never a filename, so the extension is mapped here and
 * anything unrecognised is refused before a request is made rather than after a
 * 422. `isSubtitleKind` (`subtitle-parsers.ts:57`) is the server-side twin.
 */
export function subtitleKindFor(filename: string): SubtitleKind | null {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return (SUBTITLE_KINDS as readonly string[]).includes(extension)
    ? (extension as SubtitleKind)
    : null;
}
