"use client";

import * as React from "react";

import { Button, ProgressBar, Switch } from "@montaj/ui";

import { applyCleanOp, clearCleanOp, useAudioClean, type SetAudioCleanOp } from "./use-audio-clean";
import { LocalModeNotice } from "../local-mode-gate";

import type { AudioClean, AudioCleanStrength, AudioCleanTarget } from "./audio-endpoints";

export interface AudioPanelProps {
  readonly projectId: string;
  readonly mediaId?: string;
  /** The clean id already applied, from `EdgHot.audio.clean.cleanId` (`undefined` when none). */
  readonly appliedCleanId?: string;
  /** Enqueues a `SetAudio` op through the editor's own `EdgOpQueue` — this
   * panel does not talk to the queue directly (see the final report). */
  readonly onSetAudio: (op: SetAudioCleanOp) => void;
  /**
   * D82: Deep clean (DeepFilterNet, cloud) stays greyed out with "coming to
   * cloud renders" copy until the worker-ai image build provisions the model
   * weights; `AUDIO_DEEP_CLEAN_ENABLED=1` is this panel's read of that flag.
   * Quick clean (spectral gate) is free and available on every lane either way.
   */
  readonly deepCleanEnabled?: boolean;
  /** Brief C04b §3: audio clean runs on the worker/cloud — greyed for a local project. */
  readonly isLocalProject?: boolean;
  readonly onUploadToCloud?: () => void;
  readonly uploadingToCloud?: boolean;
}

export type AudioCleanTier = "quick" | "deep";

const STRENGTHS: readonly AudioCleanStrength[] = ["light", "medium", "strong"];
const TARGETS: readonly AudioCleanTarget[] = ["social", "youtube", "podcast"];

function latestOf(cleans: readonly AudioClean[]): AudioClean | undefined {
  return cleans[0];
}

/** `"−12 LUFS → −16 LUFS, noise reduced"` (brief §3). */
export function metricsSummary(clean: AudioClean): string {
  const { metrics } = clean;
  if (metrics?.inputLufs === undefined || metrics.outputLufs === undefined) return "";
  const before = metrics.inputLufs.toFixed(0);
  const after = metrics.outputLufs.toFixed(0);
  const noise =
    metrics.snrGainDb !== undefined && metrics.snrGainDb >= 1
      ? `, noise reduced ${metrics.snrGainDb.toFixed(0)} dB`
      : "";
  return `${before} LUFS → ${after} LUFS${noise}`;
}

/**
 * The editor's Audio panel (brief §3): run controls, progress, an A/B toggle
 * that swaps the preview player between the original and cleaned 20 s clip,
 * metrics, and "Apply to export" bound to `SetAudio`.
 */
export function AudioPanel(props: AudioPanelProps): React.JSX.Element {
  const { cleans, loading, error, starting, start } = useAudioClean(props.projectId);
  const [strength, setStrength] = React.useState<AudioCleanStrength>("medium");
  const [target, setTarget] = React.useState<AudioCleanTarget>("social");
  const [tier, setTier] = React.useState<AudioCleanTier>("quick");
  const [abCleaned, setAbCleaned] = React.useState(true);
  const deepCleanEnabled = props.deepCleanEnabled === true;

  const latest = latestOf(cleans);
  const applied = latest !== undefined && props.appliedCleanId === latest.id;

  const handleRun = (): void => {
    // D82: Deep clean has no request field yet — the worker only runs the
    // Quick clean (spectral gate) chain until X07 provisions DeepFilterNet's
    // weights, so `tier` only gates this panel's own UI for now (the button
    // stays disabled unless `deepCleanEnabled`, so this never fires for "deep").
    void start({
      strength,
      target,
      ...(props.mediaId === undefined ? {} : { mediaId: props.mediaId }),
    });
  };

  const handleApplyToggle = (checked: boolean): void => {
    if (checked && latest !== undefined) props.onSetAudio(applyCleanOp(latest));
    else props.onSetAudio(clearCleanOp());
  };

  const previewSrc = abCleaned ? latest?.previewCleanedUrl : latest?.previewOriginalUrl;

  return (
    <section aria-label="Audio clean" className="flex flex-col gap-3 p-3">
      <div className="flex gap-2" role="radiogroup" aria-label="Clean tier">
        <button
          type="button"
          role="radio"
          aria-checked={tier === "quick"}
          onClick={() => setTier("quick")}
          data-testid="audio-tier-quick"
          className="flex-1 rounded-md px-2 py-1 text-xs"
        >
          Quick clean
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={tier === "deep"}
          disabled={!deepCleanEnabled}
          onClick={() => deepCleanEnabled && setTier("deep")}
          data-testid="audio-tier-deep"
          title={deepCleanEnabled ? undefined : "coming to cloud renders"}
          className="flex-1 rounded-md px-2 py-1 text-xs disabled:opacity-50"
        >
          Deep clean
        </button>
      </div>
      {!deepCleanEnabled && (
        <p className="text-xs text-muted-foreground" data-testid="audio-tier-deep-copy">
          Deep clean (DeepFilterNet) is coming to cloud renders.
        </p>
      )}

      <div className="flex gap-2">
        <label className="flex flex-col gap-1 text-xs">
          Strength
          <select
            value={strength}
            onChange={(event) => setStrength(event.target.value as AudioCleanStrength)}
          >
            {STRENGTHS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Target
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as AudioCleanTarget)}
          >
            {TARGETS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {props.isLocalProject === true ? (
        <LocalModeNotice
          feature="audio clean"
          {...(props.onUploadToCloud === undefined
            ? {}
            : { onUploadToCloud: props.onUploadToCloud })}
          uploading={props.uploadingToCloud ?? false}
        />
      ) : null}

      <Button
        type="button"
        onClick={handleRun}
        disabled={starting || props.isLocalProject === true}
      >
        {starting ? "Starting…" : "Clean audio"}
      </Button>

      {error !== undefined && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : latest !== undefined ? (
        <div className="flex flex-col gap-2" data-testid="audio-clean-result">
          {(latest.status === "queued" || latest.status === "running") && (
            <ProgressBar
              value={latest.status === "running" ? 50 : 5}
              label={latest.status === "running" ? "Cleaning…" : "Queued"}
            />
          )}
          {latest.status === "failed" && (
            <p role="alert" className="text-xs text-red-600">
              {latest.failureReason ?? "The clean failed."}
            </p>
          )}
          {latest.status === "succeeded" && (
            <>
              <p className="text-xs text-muted-foreground">{metricsSummary(latest)}</p>

              <div className="flex items-center gap-2">
                <span className="text-xs">A/B preview</span>
                <button
                  type="button"
                  aria-pressed={!abCleaned}
                  onClick={() => setAbCleaned(false)}
                  className="text-xs"
                >
                  Original
                </button>
                <button
                  type="button"
                  aria-pressed={abCleaned}
                  onClick={() => setAbCleaned(true)}
                  className="text-xs"
                >
                  Cleaned
                </button>
              </div>
              {previewSrc !== undefined && (
                <audio controls src={previewSrc} data-testid="ab-preview-player" />
              )}

              <label className="flex items-center gap-2 text-xs">
                <Switch checked={applied} onCheckedChange={handleApplyToggle} />
                Apply to export
              </label>
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No clean run yet.</p>
      )}
    </section>
  );
}
