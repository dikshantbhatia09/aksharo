"use client";

/**
 * The client's review page (2026-10-03): its calls, for someone with a review
 * link and no account.
 *
 * `auth: "public"` on every one, so the API client never attaches a session:
 * the link's token is this visit's whole credential. It travels in the
 * `X-Review-Token` header, never the request path, so no request log between
 * here and the API records a working link (`public-review.controller.ts`).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import * as React from "react";

import { defineEndpoint, isApiError, useApiClient } from "@montaj/api-client";

export const REVIEW_TOKEN_HEADER = "x-review-token";

export interface ClientClipComment {
  readonly id: string;
  readonly name: string | null;
  readonly body: string;
  readonly atMs: number | null;
  readonly createdAt: string;
}

export interface ClientClip {
  readonly id: string;
  readonly title: string;
  readonly hook: string | null;
  readonly description: string | null;
  readonly hashtags: readonly string[];
  readonly durationMs: number | null;
  readonly video: {
    readonly exportId: string;
    readonly url: string;
    readonly durationMs: number | null;
  } | null;
  readonly yourDecision: {
    readonly state: "approved" | "changes_requested";
    readonly at: string;
    readonly name: string | null;
    readonly changedSince: boolean;
  } | null;
  readonly comments: readonly ClientClipComment[];
}

export interface ClientReviewPage {
  readonly title: string;
  readonly requireName: boolean;
  readonly expiresAt: string;
  readonly clips: readonly ClientClip[];
}

const openEndpoint = defineEndpoint<void, ClientReviewPage>({
  method: "GET",
  path: "/review",
  auth: "public",
});

const decideEndpoint = defineEndpoint<
  {
    readonly decision: "approved" | "changes_requested";
    readonly name?: string;
    readonly note?: string;
    readonly expect?: string;
  },
  ClientClip
>({
  method: "POST",
  path: "/review/clips/{clipId}/decision",
  auth: "public",
});

const commentEndpoint = defineEndpoint<
  { readonly body: string; readonly atMs?: number; readonly name?: string },
  ClientClipComment
>({
  method: "POST",
  path: "/review/clips/{clipId}/comments",
  auth: "public",
});

export const clientReviewKeys = {
  page: (token: string) => ["client-review", token] as const,
};

function tokenHeader(token: string): Record<string, string> {
  return { [REVIEW_TOKEN_HEADER]: token };
}

/**
 * The page. Asked again every few minutes and when the phone comes back to it:
 * the videos' addresses are signed for twenty minutes, and the team may have
 * made a new version meanwhile. A refusal (gone, expired) is final.
 */
export function useClientReview(token: string): UseQueryResult<ClientReviewPage> {
  const client = useApiClient();
  return useQuery({
    queryKey: clientReviewKeys.page(token),
    queryFn: () => client.call(openEndpoint, { headers: tokenHeader(token) }),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (count, error) =>
      !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
  });
}

export function useClientDecision(token: string): UseMutationResult<
  ClientClip,
  Error,
  {
    readonly clipId: string;
    readonly decision: "approved" | "changes_requested";
    readonly name: string;
    readonly note?: string;
    readonly expect?: string;
  }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      client.call(decideEndpoint, {
        params: { clipId: input.clipId },
        headers: tokenHeader(token),
        body: {
          decision: input.decision,
          ...(input.name.trim() === "" ? {} : { name: input.name.trim() }),
          ...(input.note === undefined || input.note.trim() === ""
            ? {}
            : { note: input.note.trim() }),
          ...(input.expect === undefined ? {} : { expect: input.expect }),
        },
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: clientReviewKeys.page(token) });
    },
  });
}

export function useClientComment(
  token: string,
): UseMutationResult<
  ClientClipComment,
  Error,
  { readonly clipId: string; readonly body: string; readonly name: string; readonly atMs?: number }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      client.call(commentEndpoint, {
        params: { clipId: input.clipId },
        headers: tokenHeader(token),
        body: {
          body: input.body.trim(),
          ...(input.name.trim() === "" ? {} : { name: input.name.trim() }),
          ...(input.atMs === undefined ? {} : { atMs: input.atMs }),
        },
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: clientReviewKeys.page(token) });
    },
  });
}

const NAME_KEY = "aksharo.review.name";

/**
 * The name this browser reviews under, remembered so a client going through
 * several links types it once. Only a convenience: a browser that refuses
 * storage just asks again.
 */
export function useReviewerName(): readonly [string, (name: string) => void] {
  const [name, setName] = React.useState("");
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(NAME_KEY);
      if (stored !== null) setName(stored.slice(0, 60));
    } catch {
      // Storage is off (a private window, a strict browser): nothing remembered.
    }
  }, []);
  const update = React.useCallback((next: string) => {
    setName(next);
    try {
      window.localStorage.setItem(NAME_KEY, next.slice(0, 60));
    } catch {
      // As above.
    }
  }, []);
  return [name, update] as const;
}
