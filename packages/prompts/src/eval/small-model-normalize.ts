/**
 * Small-model output normalisation (M20 increment 2b).
 *
 * Small local models (qwen2.5:3b via Ollama) often return JSON that is
 * *almost* schema-valid: a chapter title a few characters over the 60-char
 * cap, an optional field spelled out as `null` instead of omitted, an edit
 * plan with one pass more than the workspace's tier allows. Applying a few
 * deterministic, conservative repairs to the raw JSON *before* it reaches
 * `outputSchema.safeParse` recovers most of these without ever inventing
 * content: every repair here either removes something the model already
 * said (a `null`, a pass, the tail of an over-cap string) or is a no-op.
 * This is called only on the Ollama path
 * (`OllamaPlannerClient`/`generateWithOllama`) — a hosted model's output is
 * used as-is, unchanged from before this module existed.
 *
 * Mirrors `apps/worker-ai/worker_ai/llm/normalize.py` field-for-field (same
 * caps, same "strip nulls, truncate on a word boundary, clamp instead of
 * failing" shape) — a diff to one side without the other is the bug this
 * doc comment exists to help a reviewer catch.
 */
import { EDIT_PLAN_PASS_KINDS, MAX_PASSES_BY_TIER } from "../templates/edit-plan.js";

import type { EditPlanPlanTier } from "../templates/edit-plan.js";
import type { InsightKind } from "../templates/registry.js";

/**
 * Recursively drop any object key whose value is `null` (an optional field
 * the model filled in explicitly instead of omitting, e.g. an edit plan's
 * `"style": null`). A `null` array *entry* is left alone — dropping it would
 * silently shift indices other fields may depend on, which is worse than the
 * problem it would "fix".
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null) continue;
      // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
      result[key] = stripNulls(entry);
    }
    return result;
  }
  return value;
}

/**
 * Truncate `text` to at most `maxLen` characters, backing off to the last
 * word boundary within budget so a cut never lands mid-word. Falls back to a
 * hard cut when the word-boundary trim would empty the string.
 */
export function truncateWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const hardCut = text.slice(0, maxLen);
  const lastSpace = hardCut.lastIndexOf(" ");
  const trimmed = (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).trimEnd();
  return trimmed !== "" ? trimmed : hardCut.trimEnd();
}

function truncateField(obj: Record<string, unknown>, key: string, maxLen: number): void {
  // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
  const value = obj[key];
  if (typeof value === "string" && value.length > maxLen) {
    // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
    obj[key] = truncateWordBoundary(value, maxLen);
  }
}

function truncateArrayField(obj: Record<string, unknown>, key: string, maxLen: number): void {
  // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
  const value = obj[key];
  if (Array.isArray(value)) {
    // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
    obj[key] = value.map((item) =>
      typeof item === "string" && item.length > maxLen ? truncateWordBoundary(item, maxLen) : item,
    );
  }
}

/**
 * Reshape a hashtag to fit the closed character class
 * (`/^#[\p{L}\p{N}_]+$/u`, `templates/hooks.ts`) WITHOUT inventing new
 * words: drop a leading `#` (re-added after), strip every character the
 * schema does not allow (spaces, hyphens, punctuation) so multi-word or
 * hyphenated hashtags collapse into one token, and re-add `#`. Leaves the
 * original string untouched if nothing usable survives -- an empty hashtag
 * is a worse failure than the one this is trying to fix, and is left for
 * the schema to reject honestly.
 */
function sanitizeHashtag(tag: unknown): unknown {
  if (typeof tag !== "string") return tag;
  const withoutHash = tag.startsWith("#") ? tag.slice(1) : tag;

  const cleaned = withoutHash.replace(/[^\p{L}\p{N}_]+/gu, "");
  return cleaned.length > 0 ? `#${cleaned}` : tag;
}

/**
 * Sanitise every hashtag (see {@link sanitizeHashtag}) and, only when there
 * are MORE than `exactLength`, truncate down to it -- never pad a short
 * list, which would mean inventing a hashtag the model never said.
 */
function normalizeHashtagsField(
  obj: Record<string, unknown>,
  key: string,
  exactLength: number,
): void {
  // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
  const value = obj[key];
  if (Array.isArray(value)) {
    const sanitized = value.map(sanitizeHashtag);
    // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
    obj[key] = sanitized.length > exactLength ? sanitized.slice(0, exactLength) : sanitized;
  }
}

/**
 * Insight templates (chapters/summary/hooks/keyphrases): truncate every
 * string field known to carry a schema max length, mirroring the caps in
 * `templates/{chapters,summary,hooks,keyphrases}.ts`'s zod schemas. Also
 * accepts `"music-mood"` / `"keyphrases"` even though they are not in
 * `InsightKind` (the `ai.llm` queue's kind allowlist) — `local-runner.ts`
 * only actually calls this for `INSIGHT_KINDS`, but the extra cases cost
 * nothing and keep this function usable if that ever changes.
 */
export function normalizeInsightOutput(
  kind: InsightKind | "keyphrases" | "music-mood",
  raw: unknown,
): unknown {
  const stripped = stripNulls(raw);
  if (stripped === null || typeof stripped !== "object") return stripped;
  const obj = stripped as Record<string, unknown>;

  if (kind === "chapters" && Array.isArray(obj["chapters"])) {
    obj["chapters"] = (obj["chapters"] as unknown[]).map((chapter) => {
      if (chapter !== null && typeof chapter === "object") {
        truncateField(chapter as Record<string, unknown>, "title", 60);
      }
      return chapter;
    });
  } else if (kind === "summary") {
    truncateField(obj, "short", 240);
    truncateField(obj, "medium", 600);
    truncateField(obj, "long", 1_200);
  } else if (kind === "hooks") {
    for (const platform of ["youtube", "instagram", "tiktok"]) {
      // eslint-disable-next-line security/detect-object-injection -- platform is one of a fixed, code-defined literal array, not attacker-controlled
      const variant = obj[platform];
      if (variant !== null && typeof variant === "object") {
        truncateArrayField(variant as Record<string, unknown>, "hooks", 120);
        truncateArrayField(variant as Record<string, unknown>, "titles", 100);
        normalizeHashtagsField(variant as Record<string, unknown>, "hashtags", 10);
      }
    }
  } else if (kind === "keyphrases" && Array.isArray(obj["keyphrases"])) {
    obj["keyphrases"] = (obj["keyphrases"] as unknown[]).map((keyphrase) => {
      if (keyphrase !== null && typeof keyphrase === "object") {
        truncateField(keyphrase as Record<string, unknown>, "phrase", 80);
      }
      return keyphrase;
    });
  }
  return obj;
}

/**
 * Edit plan: strip nulls (`"style": null` becomes omitted), truncate each
 * `rationale` entry to 240 chars, and clamp `passes`/`rationale` to the plan
 * tier's budget by dropping the LOWEST-priority passes off the end instead
 * of failing the whole plan. Priority (highest to lowest) is
 * `EDIT_PLAN_PASS_KINDS`'s own declared order — `autocut` first (the base
 * edit no plan should lose), `textfx` last — an explicit product judgement
 * call made for this normaliser, not derived from anything in the model's
 * reply. The relative order of the KEPT passes (and their rationale) is
 * preserved from the model's original reply.
 */
export function normalizeEditPlanOutput(raw: unknown, planTier: EditPlanPlanTier): unknown {
  const stripped = stripNulls(raw);
  if (stripped === null || typeof stripped !== "object") return stripped;
  const obj = stripped as Record<string, unknown>;

  const passes = Array.isArray(obj["passes"]) ? (obj["passes"] as unknown[]) : [];
  const rationale = Array.isArray(obj["rationale"]) ? (obj["rationale"] as unknown[]) : [];
  if (rationale.length > 0) {
    obj["rationale"] = rationale.map((entry) =>
      typeof entry === "string" && entry.length > 240 ? truncateWordBoundary(entry, 240) : entry,
    );
  }

  // eslint-disable-next-line security/detect-object-injection -- planTier is the EditPlanPlanTier enum, not attacker-controlled
  const cap = MAX_PASSES_BY_TIER[planTier];
  if (passes.length > cap) {
    const priorityRank = new Map<string, number>(
      EDIT_PLAN_PASS_KINDS.map((kind, index) => [kind, index]),
    );
    const rankOf = (pass: unknown): number => {
      if (pass !== null && typeof pass === "object" && "kind" in pass) {
        const kind = (pass as { kind?: unknown }).kind;
        if (typeof kind === "string" && priorityRank.has(kind)) {
          return priorityRank.get(kind) as number;
        }
      }
      // An unrecognised/missing kind is dropped first, not kept over a
      // known one -- the schema will reject it anyway if it survives.
      return EDIT_PLAN_PASS_KINDS.length;
    };
    const order = passes
      .map((_, index) => index)
      // eslint-disable-next-line security/detect-object-injection -- dynamic key from a Record<string, unknown> normalisation helper, over a code-defined key set, not attacker-controlled
      .sort((a, b) => rankOf(passes[a]) - rankOf(passes[b]));
    const keptIndices = new Set(order.slice(0, cap));
    obj["passes"] = passes.filter((_, index) => keptIndices.has(index));

    const currentRationale = Array.isArray(obj["rationale"]) ? (obj["rationale"] as unknown[]) : [];
    if (currentRationale.length === passes.length) {
      // Rationale lines up 1:1 with the original passes -- drop the same
      // indices so each kept pass keeps its own rationale.
      obj["rationale"] = currentRationale.filter((_, index) => keptIndices.has(index));
    }
    // If rationale didn't line up 1:1 to begin with, that is a separate,
    // pre-existing problem this normaliser does not guess its way around --
    // left for the schema/guardrail check to report.
  }

  // The model sometimes returns one rationale entry too many (a stray
  // closing remark, or one per param instead of one per pass) -- an EXTRA
  // entry carries no information the schema/guardrail needs, so trimming to
  // match the final pass count is safe; too FEW is left alone (nothing here
  // invents a missing explanation).
  const finalPasses = Array.isArray(obj["passes"]) ? (obj["passes"] as unknown[]) : passes;
  const finalRationale = Array.isArray(obj["rationale"]) ? (obj["rationale"] as unknown[]) : [];
  if (finalRationale.length > finalPasses.length) {
    obj["rationale"] = finalRationale.slice(0, finalPasses.length);
  }
  return obj;
}
