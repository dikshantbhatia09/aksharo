/**
 * The passes endpoints (B18's `apps/api/src/passes/**`), described the same
 * way `apps/web/lib/edg/client.ts` describes the EDG surface: `@montaj/api-
 * client`'s generated operation index already lists these routes (it is
 * regenerated from the API's own OpenAPI document), so `defineEndpoint`
 * against a listed `operationId` is typed against an id that index proves
 * exists, without `@montaj/api-client` itself carrying the descriptor yet.
 */
import { defineEndpoint } from "@montaj/api-client";

export type AutocutPreset = "conservative" | "standard" | "aggressive";

export interface AutocutOptions {
  readonly minSilenceMs?: number;
  readonly paddingMs?: number;
  readonly maxRemovalRatio?: number;
}

export interface StartAutocutRequestBody {
  readonly preset: AutocutPreset;
  readonly options?: AutocutOptions;
}

export interface PassAcceptedResponse {
  readonly jobId: string;
  readonly passId: string;
  readonly status: string;
  readonly deduplicated: boolean;
  readonly quote: {
    readonly tenths: number;
    readonly credits: string;
    readonly durationMs: number;
  };
}

/** `POST /projects/{id}/passes/autocut` — quotes, holds credits, enqueues `ai.pass`. */
export const startAutocutPass = defineEndpoint<StartAutocutRequestBody, PassAcceptedResponse>({
  method: "POST",
  path: "/projects/{projectId}/passes/autocut",
  auth: "bearer",
  operationId: "startAutocutPass",
});
