"use client";

/**
 * The workspace's brand kit (2026-10-02): its calls and hooks.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index — the same way the
 * publishing and steering calls are (`use-publishing.ts`). The settings' shape
 * is `@montaj/edg`'s `BrandKitSettings`, which the API validates with the same
 * schema, so the page and the server agree about what a kit is.
 *
 * A kit is inert until it is saved: `exists: false` reads as "no kit", the
 * start form offers no brand switch, and Autopilot adds nothing.
 *
 * Music (2026-10-04): the kit's own track, uploaded like the logo (a signed PUT,
 * then `complete`), with the person's confirmation that they have the rights
 * to use it - required on both calls, and recorded with who gave it and when.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";
import type { BrandKitSettings } from "@montaj/edg";

export type LogoContentType = "image/png" | "image/jpeg" | "image/webp";

export interface BrandKitLogo {
  readonly assetId: string;
  readonly format: "png" | "jpeg" | "webp";
  readonly contentType: LogoContentType;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number | null;
  /** Signed for an hour. */
  readonly url: string;
}

export type MusicContentType = "audio/mpeg" | "audio/wav" | "audio/mp4";

/** The kit's own music (2026-10-04). */
export interface BrandKitMusic {
  readonly assetId: string;
  readonly format: "mp3" | "wav" | "m4a";
  readonly contentType: MusicContentType;
  readonly durationMs: number;
  readonly sizeBytes: number | null;
  readonly title: string | null;
  /** Signed for an hour. */
  readonly url: string;
  /** Who confirmed the rights to use it, and when. */
  readonly rightsAttestedAt: string | null;
  readonly rightsAttestedBy: string | null;
}

/** `GET /brand-kit` (`apps/api/src/brand-kit/brand-kit.dto.ts`). */
export interface BrandKitView {
  readonly exists: boolean;
  readonly settings: BrandKitSettings;
  readonly logo: BrandKitLogo | null;
  /** Absent from an API from before music: read as none. */
  readonly music?: BrandKitMusic | null;
  /** Every logo a clip in this workspace may draw, by asset id, each signed for an hour. */
  readonly images: Readonly<Record<string, string>>;
  readonly fontFamilies: readonly string[];
  readonly limits: {
    readonly logoMaxBytes: number;
    readonly logoContentTypes: readonly string[];
    readonly logoMinSide: number;
    readonly logoMaxSide: number;
    readonly ctaMax: number;
    readonly handleMax: number;
    readonly musicMaxBytes?: number;
    readonly musicContentTypes?: readonly string[];
    readonly musicMinDurationMs?: number;
    readonly musicMaxDurationMs?: number;
  };
  readonly updatedAt: string | null;
}

export interface MusicUploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: MusicContentType;
  readonly expiresAt: string;
  readonly maxBytes: number;
}

export interface LogoUploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: LogoContentType;
  readonly expiresAt: string;
  readonly maxBytes: number;
}

export const brandKitEndpoints = {
  get: defineEndpoint<void, BrandKitView>({
    method: "GET",
    path: "/brand-kit",
    auth: "bearer",
    operationId: "getBrandKit",
  }),
  update: defineEndpoint<BrandKitSettings, BrandKitView>({
    method: "PUT",
    path: "/brand-kit",
    auth: "bearer",
    operationId: "updateBrandKit",
  }),
  createLogoUpload: defineEndpoint<
    { readonly contentType: LogoContentType; readonly sizeBytes: number },
    LogoUploadTicket
  >({
    method: "POST",
    path: "/brand-kit/logo",
    auth: "bearer",
    operationId: "createBrandKitLogoUpload",
  }),
  completeLogo: defineEndpoint<{ readonly contentType: LogoContentType }, BrandKitView>({
    method: "POST",
    path: "/brand-kit/logo/{assetId}/complete",
    auth: "bearer",
    operationId: "completeBrandKitLogo",
  }),
  removeLogo: defineEndpoint<void, BrandKitView>({
    method: "DELETE",
    path: "/brand-kit/logo",
    auth: "bearer",
    operationId: "deleteBrandKitLogo",
  }),
  createMusicUpload: defineEndpoint<
    {
      readonly contentType: MusicContentType;
      readonly sizeBytes: number;
      readonly rightsAttested: boolean;
    },
    MusicUploadTicket
  >({
    method: "POST",
    path: "/brand-kit/music",
    auth: "bearer",
    operationId: "createBrandKitMusicUpload",
  }),
  completeMusic: defineEndpoint<
    {
      readonly contentType: MusicContentType;
      readonly rightsAttested: boolean;
      readonly title?: string;
    },
    BrandKitView
  >({
    method: "POST",
    path: "/brand-kit/music/{assetId}/complete",
    auth: "bearer",
    operationId: "completeBrandKitMusic",
  }),
  removeMusic: defineEndpoint<void, BrandKitView>({
    method: "DELETE",
    path: "/brand-kit/music",
    auth: "bearer",
    operationId: "deleteBrandKitMusic",
  }),
  getWorkspaceBrandKit: defineEndpoint<void, WorkspaceBrandKitData>({
    method: "GET",
    path: "/api/v1/workspaces/{id}/brand-kit",
    auth: "bearer",
  }),
  updateWorkspaceBrandKit: defineEndpoint<UpdateWorkspaceBrandKitData, WorkspaceBrandKitData>({
    method: "PUT",
    path: "/api/v1/workspaces/{id}/brand-kit",
    auth: "bearer",
  }),
} as const;

export interface WorkspaceBrandKitData {
  readonly id?: string;
  readonly workspaceId: string;
  readonly logoUrl?: string | null;
  readonly logoPosition: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";
  readonly logoScalePct: number;
  readonly logoOpacity: number;
  readonly socialHandle?: string | null;
  readonly introVideoUrl?: string | null;
  readonly outroVideoUrl?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface UpdateWorkspaceBrandKitData {
  readonly logoUrl?: string | null;
  readonly logoPosition?: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";
  readonly logoScalePct?: number;
  readonly logoOpacity?: number;
  readonly socialHandle?: string | null;
  readonly introVideoUrl?: string | null;
  readonly outroVideoUrl?: string | null;
}

export const brandKitKeys = {
  kit: (workspaceId: string) => ["brand-kit", workspaceId] as const,
};

export const workspaceBrandKitKeys = {
  kit: (workspaceId: string) => ["workspace-brand-kit", workspaceId] as const,
};

/** The largest logo the API takes (`LOGO_MAX_BYTES`), for a friendly check before any upload. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const LOGO_CONTENT_TYPES: readonly LogoContentType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Why a chosen file cannot be a logo, before anything is sent; `null` when it can. */
export function logoFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return "A logo must be a PNG, JPEG or WebP image.";
  }
  if (file.size > LOGO_MAX_BYTES) {
    return `A logo can be at most ${String(LOGO_MAX_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.size <= 0) return "That file is empty.";
  return null;
}

/** The largest track the API takes (`MUSIC_MAX_BYTES`), for a check before any upload. */
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024;

/** What the file picker offers for music: by extension and by type. */
export const MUSIC_ACCEPT =
  ".mp3,.wav,.m4a,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a";

/**
 * The type a track is uploaded as: the one of the API's three its file is, by
 * its extension first (browsers name the same WAV `audio/wav`, `audio/x-wav` or
 * `audio/vnd.wave`), else by its type. `undefined` for anything else.
 */
export function musicContentTypeOf(file: {
  readonly name: string;
  readonly type: string;
}): MusicContentType | undefined {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "m4a") return "audio/mp4";
  if (["audio/mpeg", "audio/mp3"].includes(file.type)) return "audio/mpeg";
  if (["audio/wav", "audio/x-wav", "audio/vnd.wave", "audio/wave"].includes(file.type)) {
    return "audio/wav";
  }
  if (["audio/mp4", "audio/x-m4a", "audio/m4a"].includes(file.type)) return "audio/mp4";
  return undefined;
}

/** Why a chosen file cannot be the kit's music, before anything is sent; `null` when it can. */
export function musicFileProblem(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): string | null {
  if (musicContentTypeOf(file) === undefined) return "Music must be an MP3, WAV or M4A file.";
  if (file.size > MUSIC_MAX_BYTES) {
    return `Music can be at most ${String(MUSIC_MAX_BYTES / (1024 * 1024))} MB.`;
  }
  if (file.size <= 0) return "That file is empty.";
  return null;
}

/** A file's name without its extension: the track's title on the kit and in the editor. */
export function musicTitleOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim().slice(0, 120);
}

/** A route this API does not have yet (an older deployment) reads as "no kit", not as an error. */
function missingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

/**
 * The workspace's kit. Refetched well inside the hour its logo URLs are signed
 * for, so an editor left open keeps drawing the logo.
 */
export function useBrandKit(enabled = true): UseQueryResult<BrandKitView | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: brandKitKeys.kit(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    staleTime: 20 * 60_000,
    refetchInterval: 40 * 60_000,
    retry: (count, error) => !missingRoute(error) && count < 1,
    queryFn: async () => {
      try {
        return await client.call(brandKitEndpoints.get);
      } catch (error) {
        if (missingRoute(error)) return null;
        throw error;
      }
    },
  });
}

/** Every mutation answers the whole kit; it replaces the cached one. */
function useStoreKit(): (view: BrandKitView) => void {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return (view) => {
    if (workspaceId !== null) queryClient.setQueryData(brandKitKeys.kit(workspaceId), view);
  };
}

export function useSaveBrandKit(): UseMutationResult<BrandKitView, Error, BrandKitSettings> {
  const client = useApiClient();
  const store = useStoreKit();
  return useMutation({
    mutationFn: (settings) => client.call(brandKitEndpoints.update, { body: settings }),
    onSuccess: store,
  });
}

/**
 * Uploads a logo: a signed PUT straight to storage, then `complete`, which
 * checks the file and makes it the kit's.
 */
export function useUploadLogo(): UseMutationResult<BrandKitView, Error, File> {
  const client = useApiClient();
  const store = useStoreKit();
  return useMutation({
    mutationFn: async (file) => {
      const problem = logoFileProblem(file);
      if (problem !== null) throw new Error(problem);
      const contentType = file.type as LogoContentType;
      const ticket = await client.call(brandKitEndpoints.createLogoUpload, {
        body: { contentType, sizeBytes: file.size },
      });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error(`The upload failed (HTTP ${String(put.status)}).`);
      return client.call(brandKitEndpoints.completeLogo, {
        params: { assetId: ticket.assetId },
        body: { contentType },
      });
    },
    onSuccess: store,
  });
}

export function useRemoveLogo(): UseMutationResult<BrandKitView, Error, void> {
  const client = useApiClient();
  const store = useStoreKit();
  return useMutation({
    mutationFn: () => client.call(brandKitEndpoints.removeLogo),
    onSuccess: store,
  });
}

/**
 * Uploads the kit's music (2026-10-04): a signed PUT straight to storage, then
 * `complete`, which checks the file and makes it the kit's. `rightsAttested`
 * is the person's confirmation that they have the rights to use it; the API
 * refuses without it.
 */
export function useUploadMusic(): UseMutationResult<
  BrandKitView,
  Error,
  { readonly file: File; readonly rightsAttested: boolean }
> {
  const client = useApiClient();
  const store = useStoreKit();
  return useMutation({
    mutationFn: async ({ file, rightsAttested }) => {
      const problem = musicFileProblem(file);
      if (problem !== null) throw new Error(problem);
      if (!rightsAttested) throw new Error("Confirm that you have the rights to use this music.");
      const contentType = musicContentTypeOf(file) as MusicContentType;
      const ticket = await client.call(brandKitEndpoints.createMusicUpload, {
        body: { contentType, sizeBytes: file.size, rightsAttested },
      });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error(`The upload failed (HTTP ${String(put.status)}).`);
      const title = musicTitleOf(file.name);
      return client.call(brandKitEndpoints.completeMusic, {
        params: { assetId: ticket.assetId },
        body: { contentType, rightsAttested, ...(title === "" ? {} : { title }) },
      });
    },
    onSuccess: store,
  });
}

export function useRemoveMusic(): UseMutationResult<BrandKitView, Error, void> {
  const client = useApiClient();
  const store = useStoreKit();
  return useMutation({
    mutationFn: () => client.call(brandKitEndpoints.removeMusic),
    onSuccess: store,
  });
}

export function useWorkspaceBrandKit(): UseQueryResult<WorkspaceBrandKitData, Error> {
  const client = useApiClient();
  const rawWorkspaceId = useWorkspaceId();
  const workspaceId = rawWorkspaceId ?? "";
  return useQuery({
    queryKey: workspaceBrandKitKeys.kit(workspaceId),
    queryFn: () =>
      client.call(brandKitEndpoints.getWorkspaceBrandKit, {
        params: { id: workspaceId },
      }),
    enabled: workspaceId !== "",
  });
}

export function useUpdateWorkspaceBrandKit(): UseMutationResult<
  WorkspaceBrandKitData,
  Error,
  UpdateWorkspaceBrandKitData
> {
  const client = useApiClient();
  const rawWorkspaceId = useWorkspaceId();
  const workspaceId = rawWorkspaceId ?? "";
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      client.call(brandKitEndpoints.updateWorkspaceBrandKit, {
        params: { id: workspaceId },
        body,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(workspaceBrandKitKeys.kit(workspaceId), updated);
    },
  });
}

