"use client";

/**
 * A clip's layout on the run page (two-speaker layouts, 2026-10-01): "Auto",
 * "One speaker" or "Both speakers". Described here rather than in
 * `@montaj/api-client`'s `endpoints.ts`, for the reason `use-steering.ts`
 * gives, and settled the same way: the clip list is read back rather than the
 * change guessed at - the API may cut the clip again, or not.
 */
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import {
  defineEndpoint,
  useApiClient,
  type RepurposeClipItem,
  type RepurposeClipState,
} from "@montaj/api-client";

import { useSettle } from "@/components/repurpose/use-steering";

/** What a person picks: let the video decide, one speaker, or both stacked. */
export type ClipLayoutChoice = "auto" | "single" | "stacked";
/** How a clip's picture is cut: one window, or two people one above the other. */
export type ClipLayout = "single" | "stacked";

export const CLIP_LAYOUT_CHOICES: readonly ClipLayoutChoice[] = ["auto", "single", "stacked"];

/** What the API answers (`PUT .../clips/{clipId}/layout`). */
export interface ClipLayoutResponse {
  readonly clipId: string;
  readonly layout: ClipLayoutChoice;
  /** What the picture is, or is being cut as. */
  readonly applied: ClipLayout;
  /** Whether the clip is being cut again for it. */
  readonly recut: boolean;
  readonly clip: RepurposeClipItem | null;
}

const layoutEndpoint = defineEndpoint<{ readonly layout: ClipLayoutChoice }, ClipLayoutResponse>({
  method: "PUT",
  path: "/repurpose/runs/{runId}/clips/{clipId}/layout",
  auth: "bearer",
});

/** The layout a clip's row names; `auto` for an API from before layouts. */
export function layoutChoiceOf(clip: RepurposeClipItem): ClipLayoutChoice {
  const value = clip["layout"];
  return value === "single" || value === "stacked" ? value : "auto";
}

/** How the clip's 9:16 picture is cut: its variant's `layout`, one window when unknown. */
export function pictureLayoutOf(clip: RepurposeClipItem): ClipLayout {
  const vertical = clip.variants?.find((variant) => variant.aspect === "r9x16") as
    Record<string, unknown> | undefined;
  return vertical?.["layout"] === "stacked" ? "stacked" : "single";
}

/**
 * What the page says under the layout, or null: which layout "Auto" chose when
 * it stacked two people, and why "Both speakers" still shows one. Only for a
 * ready clip, whose picture is what it says.
 */
export function layoutNoteOf(
  clip: RepurposeClipItem,
  state: RepurposeClipState | undefined,
): "autoStacked" | "onlyOne" | null {
  if (state !== "ready") return null;
  const choice = layoutChoiceOf(clip);
  const picture = pictureLayoutOf(clip);
  if (choice === "auto" && picture === "stacked") return "autoStacked";
  if (choice === "stacked" && picture === "single") return "onlyOne";
  return null;
}

/** Set a clip's layout; the API cuts it again when its picture would change. */
export function useClipLayout(): UseMutationResult<
  ClipLayoutResponse,
  Error,
  { readonly runId: string; readonly clipId: string; readonly layout: ClipLayoutChoice }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(layoutEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: { layout: input.layout },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}
