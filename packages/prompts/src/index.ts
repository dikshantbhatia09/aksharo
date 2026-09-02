/**
 * `@montaj/prompts` — Versioned LLM prompts and their evals.
 *
 * A01 ships the package skeleton only; the general framework lands in B11
 * (prompts), D08 (eval harness). A22 adds one concrete, versioned prompt
 * (`translate.ts`, mirrored from the Python copy that actually runs) ahead of
 * that framework — see that file's own doc comment — which is why
 * `PACKAGE_INFO.implemented` below still reads `false`: the package-wide
 * versioning/eval machinery B11 owns is still unbuilt, even though one prompt
 * now lives here.
 * See README.md for what belongs here and docs/PLAN.md for scheduling.
 */

export {
  buildTranslateCaptionPrompt,
  TRANSLATE_CAPTION_PROMPT_VERSION,
  TRANSLATE_CAPTION_SYSTEM_PROMPT,
} from "./translate.js";
export type { TranslateCaptionPromptInput } from "./translate.js";

/** Build-time identity of this package, used by diagnostics bundles and the admin console. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  /** Work package(s) that implement it. */
  readonly implementedBy: string;
  /** `false` until the owning work package lands. */
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/prompts",
  implementedBy: "B11 (prompts), D08 (eval harness)",
  implemented: false,
};
