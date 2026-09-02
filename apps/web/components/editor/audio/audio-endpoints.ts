/**
 * Typed descriptors for `/projects/{id}/audio/*` (`apps/api/src/audio`).
 *
 * Not folded into `packages/api-client/src/endpoints.ts` for the same reason
 * `apps/web/lib/export/endpoints.ts` gives: that file sits outside this work
 * package's file boundary (`apps/web/components/editor/audio/**` only).
 * `defineEndpoint` is still checked against the generated operation index
 * `contract.test.ts` uses, so this is additive rather than a fork.
 */

import { defineEndpoint } from "@montaj/api-client";

export type AudioCleanStrength = "light" | "medium" | "strong";
export type AudioCleanTarget = "social" | "youtube" | "podcast";
export type AudioCleanStatus = "queued" | "running" | "succeeded" | "failed";

export interface CleanRequest {
  readonly strength: AudioCleanStrength;
  readonly target: AudioCleanTarget;
  readonly dereverb?: boolean;
  readonly deesser?: boolean;
  readonly mediaId?: string;
}

export interface CleanAccepted {
  readonly jobId: string;
  readonly cleanId: string;
  readonly status: string;
  readonly deduplicated: boolean;
  readonly quote: { readonly tenths: number; readonly credits: string; readonly durationMs: number };
}

export interface AudioCleanMetrics {
  readonly inputLufs?: number;
  readonly outputLufs?: number;
  readonly snrGainDb?: number;
  readonly clippingCount?: number;
  readonly truePeakDbtp?: number;
}

export interface AudioClean {
  readonly id: string;
  readonly projectId: string;
  readonly mediaId: string;
  readonly strength: AudioCleanStrength;
  readonly target: AudioCleanTarget;
  readonly dereverb: boolean;
  readonly deesser: boolean;
  readonly status: AudioCleanStatus;
  readonly jobId?: string;
  readonly metrics?: AudioCleanMetrics;
  readonly cleanedAudioUrl?: string;
  readonly previewOriginalUrl?: string;
  readonly previewCleanedUrl?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface AudioCleanList {
  readonly cleans: readonly AudioClean[];
}

export const audioEndpoints = {
  clean: defineEndpoint<CleanRequest, CleanAccepted>({
    method: "POST",
    path: "/projects/{projectId}/audio/clean",
    auth: "bearer",
  }),
  cleans: defineEndpoint<void, AudioCleanList>({
    method: "GET",
    path: "/projects/{projectId}/audio/cleans",
    auth: "bearer",
  }),
} as const;

/** `SetAudio.clean.preset`'s B10 convention (`exports.service.ts`'s `resolveAudioClean`). */
export function presetFor(cleanId: string): string {
  return `b10:${cleanId}`;
}
