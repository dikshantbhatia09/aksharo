/**
 * `edit-plan@1` — the prompted-edits planner (D07, 09-ai-pipeline §6).
 *
 * One LLM call turns a creator's free-text instruction ("cut the boring
 * parts and make it vertical with some music") into a JSON-schema-constrained
 * plan: an ordered list of passes with their params, an optional style/script
 * choice, and a short rationale per decision — shown to the creator in the
 * plan preview sheet (08-ux-design-system §4) *before* anything runs.
 *
 * Unlike the insight templates (`chapters`/`summary`/`hooks`), the planner
 * never invents prose the creator reads as fact — it only ever emits
 * pass kinds and params drawn from a closed, known vocabulary
 * (`EDIT_PLAN_PASS_KINDS`, `EDIT_PLAN_PARAM_SCHEMAS`), so the hallucination
 * guard here is a guardrail check (`validateEditPlan`) rather than a
 * transcript-vocabulary diff: "did the model only ever propose a pass kind
 * and param shape this build actually understands, within this plan tier's
 * budget" — never "did it invent a word".
 *
 * The transcript rides in the input purely as grounding data (same
 * `GUARDRAIL_PREAMBLE`/fenced-block treatment `common.ts` gives every other
 * template) — the planner is not asked to read it back, only to use it (if at
 * all) to decide, say, whether a "make a title for my hook" instruction needs
 * `textfx`.
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const EDIT_PLAN_TEMPLATE_VERSION = "edit-plan@1";

/** Pass kinds the planner may propose — `PassType` (CONTRACTS §2) minus `"prompted"` itself. */
export const EDIT_PLAN_PASS_KINDS = [
  "autocut",
  "zoom",
  "reframe",
  "sfx",
  "music",
  "textfx",
] as const;
export type EditPlanPassKind = (typeof EDIT_PLAN_PASS_KINDS)[number];

/** Engine tiers a pass in the plan may request (D07 §2). */
export const ENGINE_TIERS = ["flash", "pro"] as const;
export type EditPlanEngineTier = (typeof ENGINE_TIERS)[number];

/** Plan tiers that may call the planner at all (`packages/config`'s `PlanTier`, mirrored). */
export const PLAN_TIERS = ["free", "starter", "creator", "studio", "agency"] as const;
export type EditPlanPlanTier = (typeof PLAN_TIERS)[number];

/**
 * The maximum number of passes one plan may propose, by plan tier — the
 * "budget cap" the brief calls for. A free/starter workspace cannot even call
 * this planner (`promptedEdit`'s `minimumPlan: "creator"`, `@montaj/config`
 * credits.ts) but the cap is still defined for every tier so a downgraded
 * workspace's stale plan re-validates predictably rather than throwing.
 */
export const MAX_PASSES_BY_TIER: Record<EditPlanPlanTier, number> = {
  free: 1,
  starter: 2,
  creator: 4,
  studio: 6,
  agency: 6,
};

/** Only Studio/Agency may request the `pro` engine tier (mirrors `autocutPass`'s note). */
export const PRO_ENGINE_TIERS: readonly EditPlanPlanTier[] = ["studio", "agency"];

const EngineFieldSchema = z.enum(ENGINE_TIERS).default("flash");

const AutocutParamsSchema = z.object({
  preset: z.enum(["gentle", "standard", "tight"]).default("standard"),
  engine: EngineFieldSchema,
});
const ZoomParamsSchema = z.object({
  preset: z.enum(["subtle", "standard", "punchy"]).default("standard"),
  engine: EngineFieldSchema,
});
const ReframeParamsSchema = z.object({
  aspect: z.enum(["9:16", "1:1"]).default("9:16"),
  engine: EngineFieldSchema,
});
const SfxParamsSchema = z.object({ engine: EngineFieldSchema });
const MusicParamsSchema = z.object({
  mood: z.string().max(60).optional(),
  engine: EngineFieldSchema,
});
const TextFxParamsSchema = z.object({ engine: EngineFieldSchema });

/** Per-kind param schema, the closed vocabulary `validateEditPlan` checks a proposed pass against. */
export const EDIT_PLAN_PARAM_SCHEMAS = {
  autocut: AutocutParamsSchema,
  zoom: ZoomParamsSchema,
  reframe: ReframeParamsSchema,
  sfx: SfxParamsSchema,
  music: MusicParamsSchema,
  textfx: TextFxParamsSchema,
} as const satisfies Record<EditPlanPassKind, z.ZodType>;

export const EditPlanInputSchema = z.object({
  /** The creator's free-text instruction. */
  prompt: z.string().min(1).max(2_000),
  language: z.string().min(2),
  mediaTitle: z.string().max(200).optional(),
  durationMs: z.number().int().min(0),
  /** `styleRef`s already available on the project (CONTRACTS §2 `EdgHot.styles`). */
  existingStyles: z.array(z.string().min(1)).default([]),
  planTier: z.enum(PLAN_TIERS),
  /** Grounding only — never validated against the output (see file doc comment). */
  segments: z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        text: z.string(),
        speaker: z.string().optional(),
      }),
    )
    .default([]),
});
export type EditPlanInput = z.infer<typeof EditPlanInputSchema>;

const EditPlanPassSchema = z.object({
  kind: z.enum(EDIT_PLAN_PASS_KINDS),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const EditPlanOutputSchema = z.object({
  passes: z.array(EditPlanPassSchema).min(1).max(6),
  style: z.string().min(1).optional(),
  script: z.enum(["roman", "native", "translated"]).optional(),
  /** One sentence per pass, same order as `passes`, explaining why it was chosen. */
  rationale: z.array(z.string().min(1).max(240)).min(1).max(6),
});
export type EditPlanOutput = z.infer<typeof EditPlanOutputSchema>;

function buildEditPlanMessages(input: EditPlanInput): TemplateMessages {
  const kinds = EDIT_PLAN_PASS_KINDS.join(", ");
  const cap = MAX_PASSES_BY_TIER[input.planTier];
  const proAllowed = PRO_ENGINE_TIERS.includes(input.planTier);
  const system =
    "You are a video-editing planner. From the creator's instruction and this " +
    "project's facts, produce an ordered edit plan — never edit anything " +
    "yourself. " +
    GUARDRAIL_PREAMBLE +
    ` Only ever propose pass kinds from this closed list: ${kinds}. ` +
    `Propose at most ${String(cap)} passes (this workspace's plan tier budget). ` +
    (proAllowed
      ? 'The "pro" engine tier may be requested when the instruction asks for ' +
        'best quality or is willing to spend more credits; otherwise use "flash".'
      : 'This workspace\'s plan does not allow the "pro" engine tier — always use "flash".') +
    " Reply with strict JSON only, shaped " +
    '{"passes":[{"kind":string,"params":object}],"style"?:string,"script"?:' +
    '"roman"|"native"|"translated","rationale":[string, one per pass, <=240 chars]}. ' +
    "`style` must be one of the project's existing style refs if you set it. " +
    "Never propose a pass kind or param field outside the ones described above.";
  const facts =
    `Prompt: ${input.prompt}\n` +
    `Plan tier: ${input.planTier}\n` +
    `Existing styles: ${input.existingStyles.length > 0 ? input.existingStyles.join(", ") : "(none)"}`;
  const transcript: PromptTranscriptInput = {
    language: input.language,
    durationMs: input.durationMs,
    segments: input.segments,
    ...(input.mediaTitle === undefined ? {} : { mediaTitle: input.mediaTitle }),
  };
  const user = `${facts}\n\n${renderTranscriptBlock(transcript)}`;
  return { system, user };
}

export const editPlanTemplate: TemplateDefinition<EditPlanInput, EditPlanOutput> = {
  id: "edit-plan",
  version: EDIT_PLAN_TEMPLATE_VERSION,
  purpose: "Turn a free-text prompt into an ordered, budget-capped edit plan.",
  inputSchema: EditPlanInputSchema,
  outputSchema: EditPlanOutputSchema,
  maxTokens: 1024,
  temperature: 0.2,
  build: buildEditPlanMessages,
};

export interface EditPlanViolation {
  readonly code:
    | "unknown_kind"
    | "unknown_param"
    | "budget_exceeded"
    | "engine_not_allowed"
    | "unknown_style"
    | "rationale_count_mismatch";
  readonly detail: string;
}

/**
 * Guardrails an already schema-valid `EditPlanOutput` must still pass (brief
 * §1 "guardrails: only known pass kinds/params, budget caps per plan"):
 * every pass's `kind` and `params` shape are re-checked against the closed
 * per-kind schema (a schema-valid `Record<string, unknown>` could still carry
 * an unknown field or the wrong type for its kind), the plan tier's pass-count
 * budget, the `pro` engine allowlist, and that `rationale` has one entry per
 * pass so the preview sheet never shows a pass with nothing said about it.
 */
export function validateEditPlan(
  output: EditPlanOutput,
  input: Pick<EditPlanInput, "planTier" | "existingStyles">,
): readonly EditPlanViolation[] {
  const violations: EditPlanViolation[] = [];
  const cap = MAX_PASSES_BY_TIER[input.planTier];
  if (output.passes.length > cap) {
    violations.push({
      code: "budget_exceeded",
      detail: `${String(output.passes.length)} passes exceeds the ${input.planTier} tier's cap of ${String(cap)}`,
    });
  }
  const proAllowed = PRO_ENGINE_TIERS.includes(input.planTier);
  for (const [index, pass] of output.passes.entries()) {
    if (!EDIT_PLAN_PASS_KINDS.includes(pass.kind)) {
      violations.push({ code: "unknown_kind", detail: `pass ${String(index)}: "${pass.kind}"` });
      continue;
    }
    const paramSchema = EDIT_PLAN_PARAM_SCHEMAS[pass.kind];
    const parsed = paramSchema.safeParse(pass.params);
    if (!parsed.success) {
      violations.push({
        code: "unknown_param",
        detail: `pass ${String(index)} (${pass.kind}): ${parsed.error.message}`,
      });
      continue;
    }
    const engine = (parsed.data as { engine?: EditPlanEngineTier }).engine ?? "flash";
    if (engine === "pro" && !proAllowed) {
      violations.push({
        code: "engine_not_allowed",
        detail: `pass ${String(index)} (${pass.kind}): "pro" engine requires Studio/Agency, plan is ${input.planTier}`,
      });
    }
  }
  if (
    output.style !== undefined &&
    input.existingStyles.length > 0 &&
    !input.existingStyles.includes(output.style)
  ) {
    violations.push({
      code: "unknown_style",
      detail: `"${output.style}" is not an existing style`,
    });
  }
  if (output.rationale.length !== output.passes.length) {
    violations.push({
      code: "rationale_count_mismatch",
      detail: `${String(output.rationale.length)} rationale entries for ${String(output.passes.length)} passes`,
    });
  }
  return violations;
}
