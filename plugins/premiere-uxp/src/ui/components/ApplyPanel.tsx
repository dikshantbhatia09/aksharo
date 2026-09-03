import { APPLY_MODES } from "../../apply/types.js";
import { TEXT } from "../tokens.js";

import type { ApplyPlanCounts } from "../../apply/runApply.js";
import type { ApplyMode } from "../../apply/types.js";
import type { JSX } from "react";

const MODE_LABELS: Readonly<Record<ApplyMode, string>> = {
  transcript: "Transcript",
  mogrtCaptions: "MOGRT captions",
  alphaOverlay: "Alpha overlay",
  srtToBin: "SRT to bin",
  cuts: "Accepted cuts",
  zooms: "Accepted zooms",
  audio: "Cleaned audio",
  sfxMusic: "Sound effects & music",
  titles: "Titles",
};

export interface ApplyPanelProps {
  /** Dry-run preview counts (`planApply`), or `undefined` while the plan hasn't computed yet. */
  readonly counts: ApplyPlanCounts | undefined;
  readonly selected: ReadonlySet<ApplyMode>;
  readonly onToggle: (mode: ApplyMode) => void;
  /** Disables a mode with an explanatory message — e.g. a failed MOGRT self-test. */
  readonly disabledModes?: Readonly<Partial<Record<ApplyMode, string>>>;
  readonly onApply: () => void;
  readonly applying: boolean;
}

/** Apply-mode checkboxes with dry-run preview counts (C06 brief §Scope 8). */
export function ApplyPanel({
  counts,
  selected,
  onToggle,
  disabledModes,
  onApply,
  applying,
}: ApplyPanelProps): JSX.Element {
  const anySelected = selected.size > 0;

  return (
    <div data-testid="apply-panel">
      <h3>Apply to sequence</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {APPLY_MODES.map((mode) => {
          // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
          const disabledMessage = disabledModes?.[mode];
          // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
          const count = counts?.[mode] ?? 0;
          return (
            <li key={mode}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  data-testid={`apply-mode-${mode}`}
                  checked={selected.has(mode)}
                  disabled={disabledMessage !== undefined || applying}
                  onChange={() => onToggle(mode)}
                />
                {/* eslint-disable-next-line security/detect-object-injection -- bracket access on `mode`, a value from a fixed enum-like mode list, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion */}
                <span>{MODE_LABELS[mode]}</span>
                <span data-testid={`apply-mode-count-${mode}`} style={{ color: TEXT.fg2 }}>
                  ({count})
                </span>
              </label>
              {disabledMessage && (
                <p role="alert" style={{ color: TEXT.fg2, margin: "0 0 0 22px" }}>
                  {disabledMessage}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onApply} disabled={!anySelected || applying}>
        {applying ? "Applying…" : "Apply"}
      </button>
    </div>
  );
}
