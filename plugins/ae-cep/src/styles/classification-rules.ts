import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mirror of C08b's `plugins/resolve/aksharo_core_app/fusion/classification_rules.json` (Resolve
 * Fusion `Text+` capability rules for a `@montaj/caption-styles` StyleDoc v2), the same rule set
 * C06b hand-copied into `plugins/premiere-uxp/src/styles/classification-rules.ts`. That file's own
 * header says C08b's rules are meant to be mirrored by "Adobe's equivalent primitives" generally,
 * not just Premiere's MOGRT — this is the After Effects (styled text layer) mirror.
 *
 * Hand-copied, not imported: this package's file boundary is `plugins/ae-cep/**`, and
 * `plugins/resolve/**`/`plugins/premiere-uxp/**` belong to other work packages (C08b/C06b).
 * `classification-rules.test.ts` reads the canonical file at its real repository path when
 * present and asserts this constant is structurally identical to it, so any future drift fails a
 * test here rather than silently diverging — same pattern C06b used.
 *
 * `src/styles/ae-style-map.ts` evaluates these exact rules against the same StyleDoc fields
 * C08b/C06b do, then adds one AE-specific rule (`fontNotBundled`, mirroring C06b's own
 * MOGRT-specific rule) for the same font-availability gap: an AE text layer resolves fonts from
 * the machine's installed font list, so a style naming a family outside `packages/fonts`' bundled
 * OFL pack can't be authored here either.
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
 * Verbatim mirror of C08b's classification_rules.json (as copied into
 * `plugins/premiere-uxp/src/styles/classification-rules.ts` on 2026-09-03, commit 704c92b on
 * `wp/C08b`). Do not hand-edit the rule bodies without also updating the source file and
 * re-checking `classification-rules.test.ts`.
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
        "word highlight is a progressive left-to-right fill wipe; a plain AE text layer has no per-glyph masked reveal control to build it from.",
    },
    {
      id: "highlight-glow",
      field: "animation.wordHighlight.type",
      equals: "glow",
      status: "unsupported",
      reason:
        "word highlight is a glow; a styled text layer has no glow control and this WP does not stack a separate Glow effect per word.",
    },
    {
      id: "highlight-underline",
      field: "animation.wordHighlight.type",
      equals: "underline",
      status: "unsupported",
      reason:
        "word highlight is an underline; a plain AE text layer's TextDocument has no per-character underline control.",
    },
    {
      id: "highlight-box",
      field: "animation.wordHighlight.type",
      equals: "box",
      status: "approximate",
      reason:
        "word highlight is a per-word background box; this minimal panel has no per-word geometry, so it approximates this with the layer's own fill colour applied to the whole cue instead of a real drawn box.",
    },
    {
      id: "box-word-mode",
      field: "box.mode",
      equals: "word",
      when: { field: "box.enabled", equals: true },
      status: "unsupported",
      reason:
        "the background box wraps one word at a time; this WP's text layers have no independent per-word background rectangles.",
    },
    {
      id: "box-translucent-glass",
      field: "box.opacity",
      lt: 0.5,
      when: { field: "box.enabled", equals: true },
      status: "unsupported",
      reason:
        "the background is a translucent/blurred (glass) fill; a plain text layer has no backdrop-blur box to approximate it with.",
    },
    {
      id: "highlight-per-word-paging",
      field: "animation.perWord",
      equals: true,
      status: "approximate",
      reason:
        "one word is shown on screen at a time; this WP has no per-word text swapping (no full TimelineAdapter, per the brief), so it approximates by showing the whole segment's text for its full duration instead.",
    },
    {
      id: "italic-no-bundled-italic-font",
      field: "typography.italic",
      equals: true,
      status: "approximate",
      reason:
        "the style asks for italic but no italic OFL variant of the mapped font is bundled; the text layer falls back to a synthetic/faux italic on the upright weight-matched font.",
    },
  ],
  fallback: {
    supported_status: "supported",
    fallback_media: "alpha overlay",
    note: "A style classified unsupported or approximate still renders correctly in the final export: the apply flow (src/apply/applyCaptions.ts) falls back to the pre-rendered alpha overlay path (A20) whenever a style isn't text-layer-exact. Styled text layers are an editing-time convenience (a native, re-timeable layer in the AE timeline), never the only way a style reaches picture.",
  },
};

function getField(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
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
      if (STATUS_RANK[rule.status] > STATUS_RANK[status]) {
        status = rule.status;
      }
    }
  }
  return { status, reasons };
}

/** The canonical file's real repository path, if this worktree has it. */
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
  return JSON.parse(readFileSync(path, "utf8")) as ClassificationRules;
}
