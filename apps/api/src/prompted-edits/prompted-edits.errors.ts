/**
 * Error codes owned by the prompted-edits domain (CONTRACTS §8: `namespace/slug`),
 * matching `pass/*`/`transcript/*`'s own per-domain namespace.
 */
export const PROMPTED_EDIT_ERROR_CODES = {
  mediaNotReady: "prompted_edit/media_not_ready",
  transcriptNotReady: "prompted_edit/transcript_not_ready",
  planNotFound: "prompted_edit/plan_not_found",
  /** `run()` called on a plan that is not `planned` (already running/completed/failed). */
  invalidStatus: "prompted_edit/invalid_status",
  /** The mock/real planner produced an output `validateEditPlan` rejected. */
  guardrailViolation: "prompted_edit/guardrail_violation",
} as const;

export type PromptedEditErrorCode =
  (typeof PROMPTED_EDIT_ERROR_CODES)[keyof typeof PROMPTED_EDIT_ERROR_CODES];

export const PROMPTED_EDIT_CHAIN_ORDER = [
  "autocut",
  "zoom",
  "reframe",
  "sfx",
  "music",
  "textfx",
] as const;
