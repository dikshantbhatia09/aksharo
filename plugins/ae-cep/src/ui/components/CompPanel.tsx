import { t } from "../../i18n/strings.js";
import { TEXT } from "../tokens.js";

import type { ApplyCaptionsResult } from "../../apply/applyCaptions.js";
import type { CompInfo } from "../../host/ae.js";
import type { MixdownStage } from "../../upload/mixdown.js";
import type { JSX } from "react";

export interface CompPanelProps {
  readonly comp: CompInfo | undefined;
  readonly stage: MixdownStage | "idle";
  readonly stageMessage?: string;
  readonly webEditorUrl?: string;
  readonly applyResult?: ApplyCaptionsResult;
  readonly applying: boolean;
  /** False when the caller has no way to run `applyCaptions` yet (see `App.tsx`'s
   * `onApplyCaptions` doc comment) — the Apply button stays disabled rather than no-opping. */
  readonly canApply: boolean;
  readonly onCaption: () => void;
  readonly onApply: () => void;
}

function formatDuration(comp: CompInfo): string {
  if (!comp.workArea) return "—";
  const seconds = Math.round(comp.workArea.durationSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Comp info, "Caption this comp" (brief item 2: mixdown -> upload -> transcribe), and (once a
 * project exists) "Apply captions" — the apply mode itself (styled text layers vs. alpha
 * overlay) is chosen automatically per style by `applyCaptions`/`classifyStyle`, not by the
 * user, so this panel only reports which one ran.
 */
export function CompPanel({
  comp,
  stage,
  stageMessage,
  webEditorUrl,
  applyResult,
  applying,
  canApply,
  onCaption,
  onApply,
}: CompPanelProps): JSX.Element {
  if (!comp) {
    return <p data-testid="no-comp">{t("comp.noComp")}</p>;
  }

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";

  return (
    <div data-testid="comp-panel">
      <h2>{comp.name}</h2>
      <p>{t("comp.workArea", { duration: formatDuration(comp) })}</p>
      <p style={{ color: TEXT.fg2 }}>{t("comp.audioOnly")}</p>

      <button type="button" onClick={onCaption} disabled={busy}>
        {t("action.caption")}
      </button>

      {stage !== "idle" && (
        <p role="status" data-testid="stage-status">
          {stage === "mixing" && t("status.uploading", { percent: 0 })}
          {stage === "uploading" && t("status.uploading", { percent: 100 })}
          {stage === "creatingProject" && t("status.transcribing")}
          {stage === "done" && t("status.done")}
          {stage === "error" && t("status.error", { message: stageMessage ?? "" })}
        </p>
      )}

      {webEditorUrl && (
        <>
          <a href={webEditorUrl} target="_blank" rel="noreferrer">
            {t("action.openInWeb")}
          </a>
          <div>
            <button type="button" onClick={onApply} disabled={applying || !canApply}>
              {t("action.apply")}
            </button>
            {applyResult && (
              <p data-testid="apply-result">
                {applyResult.mode === "styled-text-layers"
                  ? t("applyMode.styledText")
                  : t("applyMode.overlay")}
                {" — "}
                {applyResult.layerIds.length}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
