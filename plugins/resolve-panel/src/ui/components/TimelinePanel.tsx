import { t } from "../../i18n/strings.js";
import { ACCENT, TEXT } from "../tokens.js";

import type { JSX } from "react";

export interface TimelineInfo {
  readonly name: string;
  readonly fps: number;
}

export type TranscribeStage =
  "idle" | "mixing" | "uploading" | "creating_project" | "done" | "error";

export interface TimelinePanelProps {
  readonly timeline: TimelineInfo | undefined;
  readonly stage: TranscribeStage;
  readonly stageMessage: string | undefined;
  readonly onTranscribe: () => void;
}

function stageLabel(stage: TranscribeStage, message: string | undefined): string {
  switch (stage) {
    case "mixing":
      return t("status.mixing");
    case "uploading":
      return t("status.uploading");
    case "creating_project":
      return t("status.creating_project");
    case "done":
      return t("status.done");
    case "error":
      return t("status.error", { message: message ?? "" });
    case "idle":
      return "";
  }
}

/** Source + "Caption this timeline" (brief item 1). */
export function TimelinePanel({
  timeline,
  stage,
  stageMessage,
  onTranscribe,
}: TimelinePanelProps): JSX.Element {
  if (!timeline) {
    return (
      <div data-testid="no-timeline" style={{ padding: 16, color: TEXT.fg2, fontSize: 12 }}>
        {t("project.noTimeline")}
      </div>
    );
  }

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";

  return (
    <div style={{ padding: 16 }}>
      <div data-testid="timeline-name" style={{ color: TEXT.fg0, fontSize: 13 }}>
        {timeline.name} ({timeline.fps} fps)
      </div>
      <button
        type="button"
        data-testid="transcribe-button"
        disabled={busy}
        onClick={onTranscribe}
        style={{
          marginTop: 8,
          background: ACCENT.lime500,
          color: ACCENT.onAccent,
          border: "none",
          padding: "6px 10px",
          borderRadius: 4,
        }}
      >
        {t("action.transcribe")}
      </button>
      {stage !== "idle" && (
        <div data-testid="transcribe-stage" style={{ marginTop: 8, fontSize: 12, color: TEXT.fg1 }}>
          {stageLabel(stage, stageMessage)}
        </div>
      )}
    </div>
  );
}
