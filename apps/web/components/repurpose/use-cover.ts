"use client";

/**
 * A run's cover image (2026-10-04, audiograms): the artwork an audio file's
 * clips are drawn with, above a live waveform of each clip's sound. Optional;
 * without one a run that uses the brand kit draws its logo, and any other run
 * the waveform alone.
 *
 * Uploaded before the run is started - a signed PUT straight to storage, then
 * `complete`, which checks the file - so the run can name it
 * (`setup.audiogram.coverAssetId`) from its first moment. Described here
 * rather than in `@montaj/api-client`'s `endpoints.ts`, as the brand kit's
 * calls are (`use-brand-kit.ts`).
 */
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { defineEndpoint, useApiClient } from "@montaj/api-client";

export type CoverContentType = "image/png" | "image/jpeg" | "image/webp";

export const COVER_CONTENT_TYPES: readonly CoverContentType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** The largest cover the API takes (`COVER_MAX_BYTES`), for a check before anything is sent. */
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

export interface CoverUploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: CoverContentType;
  readonly expiresAt: string;
  readonly maxBytes: number;
}

/** A cover the API has checked and kept. */
export interface CoverView {
  readonly assetId: string;
  readonly format: "png" | "jpeg" | "webp";
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number | null;
  readonly url: string;
}

export const coverEndpoints = {
  createUpload: defineEndpoint<
    { readonly contentType: CoverContentType; readonly sizeBytes: number },
    CoverUploadTicket
  >({
    method: "POST",
    path: "/repurpose/covers",
    auth: "bearer",
    operationId: "createRepurposeCoverUpload",
  }),
  complete: defineEndpoint<{ readonly contentType: CoverContentType }, CoverView>({
    method: "POST",
    path: "/repurpose/covers/{assetId}/complete",
    auth: "bearer",
    operationId: "completeRepurposeCover",
  }),
} as const;

/** Why a chosen file cannot be a cover, before anything is sent; `null` when it can. */
export function coverFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!(COVER_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return "A cover must be a PNG, JPEG or WebP image.";
  }
  if (file.size > COVER_MAX_BYTES) {
    return `A cover can be at most ${String(COVER_MAX_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.size <= 0) return "That file is empty.";
  return null;
}

/** The extensions of the sound-only files an upload may be (`@montaj/config`'s media formats). */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "weba",
]);

/**
 * Whether a picked file is sound only - the kind whose clips are audiograms.
 * By its type, else by its extension (a browser that could not name the type
 * leaves it empty). A video file with no picture is found out by the probe,
 * and is drawn an audiogram all the same; this only decides whether the form
 * offers a cover.
 */
export function isAudioFile(file: { readonly name: string; readonly type: string }): boolean {
  if (file.type.startsWith("audio/")) return true;
  if (file.type !== "" && file.type !== "application/octet-stream") return false;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

/** Uploads a cover: a signed PUT, then `complete`, which checks it and keeps it. */
export function useUploadCover(): UseMutationResult<CoverView, Error, File> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (file) => {
      const problem = coverFileProblem(file);
      if (problem !== null) throw new Error(problem);
      const contentType = file.type as CoverContentType;
      const ticket = await client.call(coverEndpoints.createUpload, {
        body: { contentType, sizeBytes: file.size },
      });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error(`The cover upload failed (HTTP ${String(put.status)}).`);
      return client.call(coverEndpoints.complete, {
        params: { assetId: ticket.assetId },
        body: { contentType },
      });
    },
  });
}
