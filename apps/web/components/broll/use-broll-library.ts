"use client";

/**
 * The workspace's B-roll library (2026-10-05): its calls and hooks.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index - the same way the
 * brand kit's calls are (`use-brand-kit.ts`).
 *
 * A picture is uploaded like a logo: a signed PUT straight to storage, then
 * `complete`, which checks the file. A photo is shrunk in the browser first to
 * {@link UPLOAD_LONG_SIDE} on its long side (a phone's 12-megapixel photo is
 * several times what a 1080 frame shows), so it arrives small.
 *
 * Stock photos (Pexels) exist only when the deployment has a key: `stock.enabled`
 * says so, and nothing offers a search without it.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";
import type { OverlayImage } from "@montaj/edg";

export type BrollContentType = "image/png" | "image/jpeg" | "image/webp";

/** A stock photo's credit, kept with it (Pexels's licence does not require it; it is kind). */
export interface BrollCredit {
  readonly provider: "pexels";
  readonly photographer: string;
  readonly photographerUrl: string;
  readonly pageUrl: string;
}

/** One picture of the library (`apps/api/src/broll/broll.dto.ts`). */
export interface BrollPicture {
  readonly assetId: string;
  readonly format: "png" | "jpeg" | "webp";
  readonly contentType: BrollContentType;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly tags: readonly string[];
  readonly title: string | null;
  readonly source: "upload" | "pexels";
  readonly credit: BrollCredit | null;
  /** Signed for an hour. */
  readonly url: string;
  readonly createdAt: string;
}

/** `GET /broll`. */
export interface BrollLibraryView {
  readonly items: readonly BrollPicture[];
  readonly stock: { readonly enabled: boolean; readonly provider: "pexels" | null };
  readonly limits: {
    readonly maxBytes: number;
    readonly contentTypes: readonly string[];
    readonly minSide: number;
    readonly maxSide: number;
    readonly uploadLongSide: number;
    readonly maxAssets: number;
    readonly maxTags: number;
    readonly tagMax: number;
    readonly titleMax: number;
  };
}

export interface BrollUploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: BrollContentType;
  readonly expiresAt: string;
  readonly maxBytes: number;
}

/** One photo a stock search found. */
export interface StockPhoto {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly photographer: string;
  readonly photographerUrl: string;
  readonly pageUrl: string;
  readonly previewUrl: string;
}

export interface StockSearchView {
  readonly provider: "pexels";
  readonly query: string;
  readonly page: number;
  readonly photos: readonly StockPhoto[];
}

export type StockOrientation = "portrait" | "landscape" | "square";

export const brollEndpoints = {
  list: defineEndpoint<void, BrollLibraryView>({
    method: "GET",
    path: "/broll",
    auth: "bearer",
    operationId: "getBrollLibrary",
  }),
  createUpload: defineEndpoint<
    { readonly contentType: BrollContentType; readonly sizeBytes: number },
    BrollUploadTicket
  >({
    method: "POST",
    path: "/broll/uploads",
    auth: "bearer",
    operationId: "createBrollUpload",
  }),
  complete: defineEndpoint<
    {
      readonly contentType: BrollContentType;
      readonly tags?: readonly string[];
      readonly title?: string;
    },
    BrollPicture
  >({
    method: "POST",
    path: "/broll/{assetId}/complete",
    auth: "bearer",
    operationId: "completeBrollUpload",
  }),
  update: defineEndpoint<
    { readonly tags?: readonly string[]; readonly title?: string },
    BrollPicture
  >({
    method: "PATCH",
    path: "/broll/{assetId}",
    auth: "bearer",
    operationId: "updateBrollPicture",
  }),
  remove: defineEndpoint<void, { readonly deleted: boolean }>({
    method: "DELETE",
    path: "/broll/{assetId}",
    auth: "bearer",
    operationId: "deleteBrollPicture",
  }),
  searchStock: defineEndpoint<void, StockSearchView>({
    method: "GET",
    path: "/broll/stock",
    auth: "bearer",
    operationId: "searchBrollStock",
  }),
  saveStock: defineEndpoint<
    { readonly photoId: number; readonly tags?: readonly string[] },
    BrollPicture
  >({
    method: "POST",
    path: "/broll/stock",
    auth: "bearer",
    operationId: "saveBrollStock",
  }),
} as const;

export const brollKeys = {
  library: (workspaceId: string) => ["broll", workspaceId] as const,
  stock: (workspaceId: string, query: string, orientation: string, page: number) =>
    ["broll", workspaceId, "stock", query, orientation, page] as const,
};

/** The types a picture may be, for the file picker. */
export const BROLL_CONTENT_TYPES: readonly BrollContentType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

/** The largest picture the API keeps (`BROLL_MAX_BYTES`), for a check before anything is sent. */
export const BROLL_MAX_BYTES = 8 * 1024 * 1024;

/** The long side a photo is shrunk to before it is uploaded (`BROLL_UPLOAD_LONG_SIDE`). */
export const UPLOAD_LONG_SIDE = 2560;

/** The most tags on one picture, and the longest tag (`BROLL_MAX_TAGS`, `BROLL_TAG_MAX`). */
export const MAX_TAGS = 10;
export const TAG_MAX = 40;

/** Why a chosen file cannot be a picture, before anything is sent; `null` when it can be. */
export function brollFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!(BROLL_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return "A picture must be a JPEG, PNG or WebP image.";
  }
  if (file.size <= 0) return "That file is empty.";
  return null;
}

/**
 * Tags as a person types them ("taj mahal, Agra fort"): trimmed, lower case,
 * the empty and the repeated left out, at most {@link MAX_TAGS}.
 */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const part of text.split(/[,\n]/u)) {
    const tag = part.trim().toLowerCase().replace(/\s+/gu, " ").slice(0, TAG_MAX).trim();
    if (tag === "" || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * A first tag from a file's name ("taj-mahal_sunrise.jpg" is "taj mahal
 * sunrise"), or none for a camera's own name (IMG_2031, DSC0001, PXL_...).
 */
export function tagsFromFileName(name: string): string[] {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[_\-.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (base === "" || /^(img|dsc|dscn|pxl|photo|image|screenshot|whatsapp)\b/u.test(base)) return [];
  if (!/\p{L}{3,}/u.test(base)) return [];
  const words = base.split(" ").filter((word) => !/^\d+$/u.test(word));
  return words.length === 0 ? [] : parseTags(words.join(" "));
}

/**
 * What B-roll a run could get here (2026-10-05): `library` when the workspace
 * has pictures (the start form's switch is then on by default), `stock` when it
 * has none but stock photos are set up (off by default: stock photos in every
 * clip is a choice to make, not a default), `undefined` when nothing could fill
 * a cutaway (no switch at all).
 */
export type BrollOffer = "library" | "stock";

export function brollOfferOf(view: BrollLibraryView | null | undefined): BrollOffer | undefined {
  if (view === null || view === undefined) return undefined;
  if (view.items.length > 0) return "library";
  return view.stock.enabled ? "stock" : undefined;
}

/** The pictures as a renderer registers them: asset id to its signed URL. */
export function brollImagesOf(
  view: BrollLibraryView | null | undefined,
): Readonly<Record<string, string>> {
  const images: Record<string, string> = {};
  for (const picture of view?.items ?? []) images[picture.assetId] = picture.url;
  return images;
}

/** A picture as a B-roll overlay names it. */
export function overlayImageOfPicture(picture: BrollPicture): OverlayImage {
  return {
    assetId: picture.assetId,
    format: picture.format,
    width: picture.width,
    height: picture.height,
  };
}

/** A route this API does not have yet (an older deployment) reads as "no library", not an error. */
function missingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

/**
 * The workspace's library. Refetched well inside the hour its URLs are signed
 * for, so an editor left open keeps drawing its cutaways.
 */
export function useBrollLibrary(enabled = true): UseQueryResult<BrollLibraryView | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: brollKeys.library(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    staleTime: 20 * 60_000,
    refetchInterval: 40 * 60_000,
    retry: (count, error) => !missingRoute(error) && count < 1,
    queryFn: async () => {
      try {
        return await client.call(brollEndpoints.list);
      } catch (error) {
        if (missingRoute(error)) return null;
        throw error;
      }
    },
  });
}

function useRefreshLibrary(): () => Promise<void> {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return async () => {
    if (workspaceId === null) return;
    await queryClient.invalidateQueries({ queryKey: brollKeys.library(workspaceId) });
  };
}

/**
 * A photo, shrunk to {@link UPLOAD_LONG_SIDE} on its long side as a JPEG when
 * it is larger than that (or over the byte cap), and otherwise as it is. A
 * browser that cannot decode it here sends it as it is, and the API judges it.
 */
export async function shrinkForUpload(
  file: File,
): Promise<{ readonly body: Blob; readonly contentType: BrollContentType }> {
  const asIs = { body: file as Blob, contentType: file.type as BrollContentType };
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return asIs;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return asIs;
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (long <= UPLOAD_LONG_SIDE && file.size <= BROLL_MAX_BYTES) return asIs;
    const scale = Math.min(1, UPLOAD_LONG_SIDE / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return asIs;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.9);
    });
    return blob === null ? asIs : { body: blob, contentType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}

/** Uploads a picture: shrunk, a signed PUT straight to storage, then `complete`. */
export function useUploadBrollPicture(): UseMutationResult<
  BrollPicture,
  Error,
  { readonly file: File; readonly tags?: readonly string[] }
> {
  const client = useApiClient();
  const refresh = useRefreshLibrary();
  return useMutation({
    mutationFn: async ({ file, tags }) => {
      const problem = brollFileProblem(file);
      if (problem !== null) throw new Error(problem);
      const { body, contentType } = await shrinkForUpload(file);
      if (body.size > BROLL_MAX_BYTES) {
        throw new Error(`A picture can be at most ${String(BROLL_MAX_BYTES / (1024 * 1024))} MB.`);
      }
      const ticket = await client.call(brollEndpoints.createUpload, {
        body: { contentType, sizeBytes: body.size },
      });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body,
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error(`The upload failed (HTTP ${String(put.status)}).`);
      const dot = file.name.lastIndexOf(".");
      const title = (dot > 0 ? file.name.slice(0, dot) : file.name).trim().slice(0, 120);
      const allTags = tags ?? tagsFromFileName(file.name);
      return client.call(brollEndpoints.complete, {
        params: { assetId: ticket.assetId },
        body: {
          contentType,
          ...(allTags.length === 0 ? {} : { tags: allTags }),
          ...(title === "" ? {} : { title }),
        },
      });
    },
    onSuccess: async () => {
      await refresh();
    },
  });
}

export function useUpdateBrollPicture(): UseMutationResult<
  BrollPicture,
  Error,
  { readonly assetId: string; readonly tags?: readonly string[]; readonly title?: string }
> {
  const client = useApiClient();
  const refresh = useRefreshLibrary();
  return useMutation({
    mutationFn: ({ assetId, ...body }) =>
      client.call(brollEndpoints.update, { params: { assetId }, body }),
    onSuccess: async () => {
      await refresh();
    },
  });
}

export function useDeleteBrollPicture(): UseMutationResult<
  { readonly deleted: boolean },
  Error,
  string
> {
  const client = useApiClient();
  const refresh = useRefreshLibrary();
  return useMutation({
    mutationFn: (assetId) => client.call(brollEndpoints.remove, { params: { assetId } }),
    onSuccess: async () => {
      await refresh();
    },
  });
}

/** One page of stock photos for `query`; idle while the query is too short or stock is off. */
export function useStockSearch(
  query: string,
  orientation: StockOrientation | undefined,
  enabled: boolean,
): UseQueryResult<StockSearchView> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const trimmed = query.trim();
  return useQuery({
    queryKey: brollKeys.stock(workspaceId ?? "none", trimmed, orientation ?? "any", 1),
    enabled: enabled && workspaceId !== null && trimmed.length >= 2,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: () =>
      client.call(brollEndpoints.searchStock, {
        query: { query: trimmed, ...(orientation === undefined ? {} : { orientation }) },
      }),
  });
}

/** Keeps a stock photo in the library; answers the picture. */
export function useSaveStockPhoto(): UseMutationResult<
  BrollPicture,
  Error,
  { readonly photoId: number; readonly tags?: readonly string[] }
> {
  const client = useApiClient();
  const refresh = useRefreshLibrary();
  return useMutation({
    mutationFn: (body) => client.call(brollEndpoints.saveStock, { body }),
    onSuccess: async () => {
      await refresh();
    },
  });
}
