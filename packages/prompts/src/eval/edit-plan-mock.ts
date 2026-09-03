/**
 * Fake/mock generator for `edit-plan@1` (mirrors `mock-provider.ts`'s role
 * for the insight templates, brief §6 "no LLM keys": prompted edits are
 * proven through this deterministic seam, never a real provider, in CI and
 * on the no-key build machine). Builds a schema- and guardrail-valid plan
 * from simple keyword matching on the prompt — good enough to exercise the
 * planner's schema, budget caps and engine-tier guardrails without a model.
 */
import {
  MAX_PASSES_BY_TIER,
  PRO_ENGINE_TIERS,
  type EditPlanEngineTier,
  type EditPlanInput,
  type EditPlanOutput,
  type EditPlanPassKind,
} from "../templates/edit-plan.js";

interface KeywordRule {
  readonly kind: EditPlanPassKind;
  readonly test: (prompt: string) => boolean;
  readonly params: (prompt: string) => Record<string, unknown>;
  readonly rationale: (prompt: string) => string;
}

const RULES: readonly KeywordRule[] = [
  {
    kind: "autocut",
    test: (p) => /cut|silence|pause|boring|clean/.test(p) || /चुप्पी|काटो|हटाओ/.test(p),
    params: () => ({ preset: "standard" }),
    rationale: () => "The prompt asks to remove dead air, so an autocut pass runs first.",
  },
  {
    kind: "reframe",
    test: (p) => /vertical|reels|9:16|shorts|tiktok|செங்குத்து/.test(p),
    params: () => ({ aspect: "9:16" }),
    rationale: () => "The prompt asks for a vertical/short-form frame, so reframe runs.",
  },
  {
    kind: "zoom",
    test: (p) => /zoom|punch.?in|excited|emphasis/.test(p),
    params: () => ({ preset: "standard" }),
    rationale: () => "The prompt asks to punch in on key moments, so a zoom pass runs.",
  },
  {
    kind: "sfx",
    test: (p) => /sound effect|sfx|whoosh|laugh/.test(p),
    params: () => ({}),
    rationale: () => "The prompt asks for sound effects, so an sfx pass runs.",
  },
  {
    kind: "music",
    test: (p) => /music|song|संगीत|soundtrack/.test(p),
    params: () => ({}),
    rationale: () => "The prompt asks for background music, so a music pass runs.",
  },
  {
    kind: "textfx",
    test: (p) => /title|caption text|hook|stat/.test(p),
    params: () => ({}),
    rationale: () => "The prompt asks for on-screen titles, so a text-fx pass runs.",
  },
];

function engineFor(prompt: string, planTier: EditPlanInput["planTier"]): EditPlanEngineTier {
  const wantsPro = /best quality|spare no credits|highest quality|pro engine/i.test(prompt);
  return wantsPro && PRO_ENGINE_TIERS.includes(planTier) ? "pro" : "flash";
}

export function mockEditPlan(input: EditPlanInput): EditPlanOutput {
  const lower = input.prompt.toLowerCase();
  const engine = engineFor(input.prompt, input.planTier);
  const cap = MAX_PASSES_BY_TIER[input.planTier];

  const matched = RULES.filter((rule) => rule.test(lower) || rule.test(input.prompt));
  const chosen = (matched.length > 0 ? matched : [RULES[0] as KeywordRule]).slice(0, cap);

  const passes: EditPlanOutput["passes"] = chosen.map((rule) => ({
    kind: rule.kind,
    params: { ...rule.params(input.prompt), engine },
  }));
  const rationale = chosen.map((rule) => rule.rationale(input.prompt));

  const style =
    input.existingStyles.length > 0 ? input.existingStyles[0] : undefined;

  return {
    passes,
    rationale,
    ...(style === undefined ? {} : { style }),
  };
}
