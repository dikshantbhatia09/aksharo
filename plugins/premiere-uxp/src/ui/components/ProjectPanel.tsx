import { t } from "../../i18n/strings.js";
import { TEXT } from "../tokens.js";

import type { SequenceInfo } from "../../host/premiere.js";
import type { MixdownStage } from "../../upload/mixdown.js";
import type { JSX } from "react";

export interface ProjectPanelProps {
  readonly sequence: SequenceInfo | undefined;
  readonly stage: MixdownStage | "idle";
  readonly stageMessage?: string;
  readonly webEditorUrl?: string;
  readonly onTranscribe: () => void;
}

function formatDuration(sequence: SequenceInfo): string {
  if (!sequence.inOut) return "—";
  const frames = sequence.inOut.endFrames - sequence.inOut.startFrames;
  const seconds = Math.round(frames / sequence.frameRate.fps);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Source info, "Transcribe this sequence", status/progress, and a link to the web editor. */
export function ProjectPanel({
  sequence,
  stage,
  stageMessage,
  webEditorUrl,
  onTranscribe,
}: ProjectPanelProps): JSX.Element {
  if (!sequence) {
    return <p data-testid="no-sequence">{t("source.noSequence")}</p>;
  }

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";

  return (
    <div data-testid="project-panel">
      <h2>{sequence.name}</h2>
      <p>{t("source.inOut", { duration: formatDuration(sequence) })}</p>
      <p style={{ color: TEXT.fg2 }}>{t("source.audioOnly")}</p>

      <button type="button" onClick={onTranscribe} disabled={busy}>
        {t("action.transcribe")}
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
        <a href={webEditorUrl} target="_blank" rel="noreferrer">
          {t("action.openInWeb")}
        </a>
      )}
    </div>
  );
}
