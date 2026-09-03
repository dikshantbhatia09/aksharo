import { MOGRT_PARAMS, MOGRT_PARAM_NAMES } from "./params.js";

import type { MogrtParamDef } from "./params.js";

/**
 * The Aksharo **title** `.mogrt` param table (D09): a second, separate MOGRT from C06b's
 * caption one (`params.ts`), added to that same generator per the D09 brief ("a second Aksharo
 * title `.mogrt` defined by C06b's generator with the D06 presets — add its definition to
 * C06b's generator in this WP").
 *
 * It reuses the whole frozen 14-param caption table verbatim (same names, same order, same
 * index-fallback contract `mogrt/params.ts` documents) so the two MOGRTs' `Text`/`Font`/`Size`/
 * colour/position/highlight params stay one shared vocabulary, and appends one new param at
 * index 14: `MotionPreset`, naming which of the D06 text-fx presets
 * (`pop`|`slide-up`|`typewriter`|`underline`|`count-up`|`fade`, CONTRACTS §2 amendment's
 * `TitlePayload.motionPreset`) this instance was authored for. `@montaj/shared-apply`'s
 * `motionPresets.ts` resolves the preset -> param values (`PositionY`, `HighlightStart/End`)
 * this WP's `src/apply/titles.ts` writes; `MotionPreset` itself is written verbatim so a human
 * editor (or the start-up self-test) can read back which preset produced an instance's params.
 *
 * Like the caption table, this is append-only: a new preset never renames or reorders an
 * existing param.
 */

export const MOTION_PRESET_PARAM_NAME = "MotionPreset" as const;

export const TITLE_PARAM_NAMES = [...MOGRT_PARAM_NAMES, MOTION_PRESET_PARAM_NAME] as const;

export type TitleParamName = (typeof TITLE_PARAM_NAMES)[number];

const MOTION_PRESET_PARAM: MogrtParamDef = {
  index: MOGRT_PARAMS.length,
  name: MOTION_PRESET_PARAM_NAME,
  displayName: MOTION_PRESET_PARAM_NAME,
  type: "text",
  defaultValue: "fade",
  description:
    "The D06 motion preset id (pop|slide-up|typewriter|underline|count-up|fade, CONTRACTS §2 " +
    "TitlePayload.motionPreset) baked into this instance; a human AE author uses this to pick " +
    "which animation preset the text layer plays (docs/MOGRT-PARAMS.md#title).",
};

/** The 15 frozen title params, in order: the 14 caption params (0-13) plus `MotionPreset` (14). */
export const TITLE_PARAMS: readonly MogrtParamDef[] = [...MOGRT_PARAMS, MOTION_PRESET_PARAM];
