import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mirror of C08b's `plugins/resolve/aksharo_core_app/fusion/classification_rules.json`
 * (Resolve Fusion `Text+` capability rules for a `@montaj/caption-styles` StyleDoc
 * v2). C08b's own file header says it plainly: "C06b (Premiere MOGRT authoring)
 * mirrors these same predicates against Adobe's equivalent primitives ... so the
 * two hosts' coverage reports stay comparable."
 *
 * This is a **hand-copied mirror**, not a live import — this package's file
 * boundary is `plugins/premiere-uxp/**`, and `plugins/resolve/**` belongs to
 * C08b/C08. `classification-rules.test.ts` reads the canonical file at its
 * real repository path when present (it will be, once `wp/C08b` is on `main`)
 * and asserts this constant is structurally identical to it, so any future
 * drift between the two fails a test here rather than silently diverging.
 *
 * `src/styles/mogrt-map.ts` evaluates these exact rules against the same
 * StyleDoc fields C08b does, then adds MOGRT-specific rules only where the
 * two hosts' primitives genuinely differ (documented in that module).
 */

export type ClassificationStatus = "supported" | "approximate" | "unsupported";

export interface ClassificationRuleCondition {
  field: string;
  equals?: unknown;
}

export interface ClassificationRule extends ClassificationRuleCondition {
  id: string;
  /** Numeric less-than comparison against the field, alternative to `equals`. */
  lt?: number;
  /** The rule only fires when this guard condition also holds. */
  when?: ClassificationRuleCondition;
  status: ClassificationStatus;
  reason: string;
}

export interface ClassificationRules {
  version: number;
  rules: ClassificationRule[];
  fallback: {
    supported_status: string;
    fallback_media: string;
    note: string;
  };
}

/**
 * Verbatim mirror of C08b's classification_rules.json (read on 2026-09-03,
 * commit 704c92b on `wp/C08b`). Do not hand-edit the rule bodies without also
 * updating the source file and re-checking `classification-rules.test.ts`.
 */
export const SHARED_CLASSIFICATION_RULES: ClassificationRules = {
  version: 1,
  rules: [
    {
      id: "highlight-karaoke-fill",
      field: "animation.wordHighlight.type",
      equals: "karaoke-fill",
      status: "unsupported",
      reason:
        "word highlight is a progressive left-to-right fill wipe; the animator range selector has no per-glyph masked reveal control to build it from.",
    },
    {
      id: "highlight-glow",
      field: "animation.wordHighlight.type",
      equals: "glow",
      status: "unsupported",
      reason:
        "word highlight is a glow; the MOGRT has no glow control and does not stack a separate Glow effect per word.",
    },
    {
      id: "highlight-underline",
      field: "animation.wordHighlight.type",
      equals: "underline",
      status: "unsupported",
      reason:
        "word highlight is an underline; the animator range selector has no per-character underline control.",
    },
    {
      id: "highlight-box",
      field: "animation.wordHighlight.type",
      equals: "box",
      status: "approximate",
      reason:
        "word highlight is a per-word background box; the MOGRT has no per-word geometry, so it approximates this with the HighlightColour/HighlightStart/HighlightEnd character-range colour sweep instead of a real drawn box.",
    },
    {
      id: "box-word-mode",
      field: "box.mode",
      equals: "word",
      when: { field: "box.enabled", equals: true },
      status: "unsupported",
      reason:
        "the background box wraps one word at a time; BoxFill/BoxOpacity apply to the whole cue, not independent per-word rectangles.",
    },
    {
      id: "box-translucent-glass",
      field: "box.opacity",
      lt: 0.5,
      when: { field: "box.enabled", equals: true },
      status: "unsupported",
      reason:
        "the background is a translucent/blurred (glass) fill; BoxFill/BoxOpacity give a flat colour with no backdrop blur.",
    },
    {
      id: "highlight-per-word-paging",
      field: "animation.perWord",
      equals: true,
      status: "approximate",
      reason:
        "one word is shown on screen at a time; the MOGRT approximates this by keyframing Text to swap per word at HighlightStart/HighlightEnd boundaries rather than natively paging words like the web renderer.",
    },
    {
      id: "italic-no-bundled-italic-font",
      field: "typography.italic",
      equals: true,
      status: "approximate",
      reason:
        "the style asks for italic but no italic OFL variant of the mapped font is bundled; the MOGRT falls back to a synthetic/faux italic on the upright weight-matched font.",
    },
  ],
  fallback: {
    supported_status: "supported",
    fallback_media: "alpha overlay",
    note: "A style classified unsupported or approximate still renders correctly in the final export: C06's apply-modes flow uses the pre-rendered alpha overlay path (A20) whenever a style isn't MOGRT-exact. The MOGRT path is an editing-time convenience (a native, re-timeable clip in the Premiere timeline), never the only way a style reaches picture.",
  },
};

function getField(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function ruleFires(rule: ClassificationRule, style: unknown): boolean {
  if (rule.when) {
    const guardValue = getField(style, rule.when.field);
    if (guardValue !== rule.when.equals) {
      return false;
    }
  }
  const value = getField(style, rule.field);
  if (rule.equals !== undefined) {
    return value === rule.equals;
  }
  if (rule.lt !== undefined) {
    return typeof value === "number" && value < rule.lt;
  }
  return false;
}

const STATUS_RANK: Record<ClassificationStatus, number> = {
  supported: 0,
  approximate: 1,
  unsupported: 2,
};

/** Applies every rule that fires against `style`; returns the worst status (unsupported > approximate > supported) and every reason that produced it. */
export function applyClassificationRules(
  style: unknown,
  rules: ClassificationRule[] = SHARED_CLASSIFICATION_RULES.rules,
): { status: ClassificationStatus; reasons: string[] } {
  let status: ClassificationStatus = "supported";
  const reasons: string[] = [];
  for (const rule of rules) {
    if (ruleFires(rule, style)) {
      reasons.push(rule.reason);
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      if (STATUS_RANK[rule.status] > STATUS_RANK[status]) {
        status = rule.status;
      }
    }
  }
  return { status, reasons };
}

/** The canonical file's real repository path, if this worktree has it (i.e. `wp/C08b` has merged into `main`). */
export function findCanonicalRulesPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(
    here,
    "..",
    "..",
    "..",
    "resolve",
    "aksharo_core_app",
    "fusion",
    "classification_rules.json",
  );
  return existsSync(path) ? path : undefined;
}

export function readCanonicalRules(path: string): ClassificationRules {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  return JSON.parse(readFileSync(path, "utf8")) as ClassificationRules;
}
