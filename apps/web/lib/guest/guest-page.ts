"use client";

/**
 * A guest's page (2026-10-05): its calls, for someone with a guest link and no
 * account.
 *
 * `auth: "public"` on every one, so the API client never attaches a session:
 * the link's token is this visit's whole credential. It travels in the
 * `X-Guest-Token` header, never the request path, so no request log between
 * here and the API records a working link (`public-guest.controller.ts`).
 */
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient } from "@montaj/api-client";

export const GUEST_TOKEN_HEADER = "x-guest-token";

export type GuestShape = "9:16" | "4:5" | "1:1" | "16:9";

export interface GuestVideo {
  readonly shape: GuestShape;
  readonly width: number;
  readonly height: number;
  /** With captions, as a download; null when only the clean cut exists. */
  readonly url: string | null;
  /** Without captions, as a download; null when there is none. */
  readonly cleanUrl: string | null;
}

export interface GuestImage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** One per frame (a carousel has five), each a download. */
  readonly urls: readonly string[];
}

export interface GuestDub {
  readonly language: string;
  readonly name: string;
  readonly videos: readonly GuestVideo[];
}

export type GuestPlatform =
  "any" | "youtube" | "instagram" | "tiktok" | "linkedin" | "x" | "facebook";

export interface GuestPost {
  readonly platform: GuestPlatform;
  readonly title: string | null;
  readonly text: string;
}

export interface GuestClip {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number | null;
  readonly player: {
    readonly shape: GuestShape;
    readonly url: string;
    readonly captioned: boolean;
    readonly posterUrl: string | null;
  } | null;
  readonly videos: readonly GuestVideo[];
  readonly images: readonly GuestImage[];
  readonly dubs: readonly GuestDub[];
  readonly hashtags: readonly string[];
  readonly posts: readonly GuestPost[];
}

export interface GuestPage {
  readonly title: string;
  readonly guestName: string | null;
  readonly expiresAt: string;
  readonly clips: readonly GuestClip[];
  readonly comingSoon: number;
  readonly episode: {
    readonly linkedin: string | null;
    readonly xThread: readonly string[];
  } | null;
}

/** What a download names, for the team's count and the audit trail. */
export interface GuestDownload {
  readonly clipId: string;
  readonly file: "video" | "clean" | "image" | "dub" | "dub-clean";
  readonly shape?: GuestShape;
  readonly image?: string;
  readonly language?: string;
}

const openEndpoint = defineEndpoint<void, GuestPage>({
  method: "GET",
  path: "/guest",
  auth: "public",
});

const downloadEndpoint = defineEndpoint<GuestDownload, void>({
  method: "POST",
  path: "/guest/downloads",
  auth: "public",
});

export const guestPageKeys = {
  page: (token: string) => ["guest-page", token] as const,
};

function tokenHeader(token: string): Record<string, string> {
  return { [GUEST_TOKEN_HEADER]: token };
}

/**
 * The page. Asked again every few minutes and when the phone comes back to it:
 * its files are signed for twenty minutes, and the team may have made new
 * clips meanwhile. A refusal (gone, expired) is final.
 */
export function useGuestPage(token: string): UseQueryResult<GuestPage> {
  const client = useApiClient();
  return useQuery({
    queryKey: guestPageKeys.page(token),
    queryFn: () => client.call(openEndpoint, { headers: tokenHeader(token) }),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (count, error) =>
      !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
  });
}

/**
 * Tell the team a download started. Fired as the download begins and never
 * waited on: the file was signed when the page loaded, so a count that fails
 * (offline, too many at once) costs the guest nothing.
 */
export function useCountGuestDownload(
  token: string,
): UseMutationResult<void, Error, GuestDownload> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (download) =>
      client.call(downloadEndpoint, { headers: tokenHeader(token), body: download }),
    retry: false,
  });
}
