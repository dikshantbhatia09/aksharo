/**
 * The prompted-edits endpoints (D07's `apps/api/src/prompted-edits/**`),
 * described the same way `lib/passes/client.ts` describes `startAutocutPass`
 * — `defineEndpoint` against an `operationId` `@montaj/api-client`'s
 * generated operation index proves exists (`pnpm gen:client`).
 */
import { defineEndpoint } from "@montaj/api-client";

export type PromptedEditEngine = "flash" | "pro";
export type PromptedEditPassKind = "autocut" | "zoom" | "reframe" | "sfx" | "music" | "textfx";
export type PromptedEditStatus = "planned" | "running" | "completed" | "failed";

export interface PromptedEditPlanPass {
  readonly kind: PromptedEditPassKind;
  readonly params: Record<string, unknown>;
}

export interface PromptedEditPlanResponse {
  readonly id: string;
  readonly prompt: string;
  readonly engine: PromptedEditEngine;
  readonly passes: readonly PromptedEditPlanPass[];
  readonly style?: string;
  readonly script?: "roman" | "native" | "translated";
  readonly rationale: readonly string[];
  readonly status: PromptedEditStatus;
  readonly holdTenths: number;
  readonly holdCredits: string;
  readonly settledTenths?: number;
  readonly createdAt: string;
}

export interface CreatePromptedEditPlanBody {
  readonly prompt: string;
  readonly engine: PromptedEditEngine;
}

/** `POST /projects/{id}/prompted-edits` — plan only; nothing runs yet. */
export const createPromptedEditPlan = defineEndpoint<
  CreatePromptedEditPlanBody,
  PromptedEditPlanResponse
>({
  method: "POST",
  path: "/projects/{projectId}/prompted-edits",
  auth: "bearer",
  operationId: "createPromptedEditPlan",
});

/** `GET /projects/{id}/prompted-edits/{planId}` — read a plan back for the preview sheet. */
export const getPromptedEditPlan = defineEndpoint<never, PromptedEditPlanResponse>({
  method: "GET",
  path: "/projects/{projectId}/prompted-edits/{planId}",
  auth: "bearer",
  operationId: "getPromptedEditPlan",
});

export interface RunPromptedEditPlanResponse {
  readonly planId: string;
  readonly jobId: string;
  readonly firstPassKind: string;
  readonly status: string;
  readonly holdTenths: number;
  readonly holdCredits: string;
}

/** `POST /projects/{id}/prompted-edits/{planId}/run` — holds credits, starts the chain. */
export const runPromptedEditPlan = defineEndpoint<never, RunPromptedEditPlanResponse>({
  method: "POST",
  path: "/projects/{projectId}/prompted-edits/{planId}/run",
  auth: "bearer",
  operationId: "runPromptedEditPlan",
});

/** Human-readable label for a pass kind, for the plan preview sheet's chip list. */
export const PASS_KIND_LABELS: Record<PromptedEditPassKind, string> = {
  autocut: "Autocut",
  zoom: "Zoom",
  reframe: "Reframe",
  sfx: "Sound effects",
  music: "Music",
  textfx: "Titles",
};
