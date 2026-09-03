"use client";

/**
 * The Audio panel's state: run a clean, poll its history, drive the A/B
 * preview and "Apply to export" toggle (brief §3).
 *
 * Polling rather than a realtime subscription: `job.completed` on the
 * project's realtime room already tells the rest of the editor a job
 * finished, but wiring this panel to that bus is a store-integration point
 * this work package's remaining time did not reach (see the final report's
 * "left undone" list) — a 3 s poll while a run is in flight is a correct,
 * if less elegant, substitute, and stops once nothing is queued or running.
 */

import * as React from "react";

import { useApiClient } from "@montaj/api-client";

import {
  audioEndpoints,
  type AudioClean,
  type AudioCleanStrength,
  type AudioCleanTarget,
} from "./audio-endpoints";

const POLL_MS = 3_000;

export interface SetAudioCleanOp {
  readonly clean: {
    readonly enabled: boolean;
    /** First-class as of B10b (CONTRACTS §2); `null` clears a previously applied clean. */
    readonly cleanId: string | null;
    readonly targetLufs: number;
  };
}

/** `TARGET_LUFS` mirrored from `worker_ai.clean.dsp` (brief §1) for the "Apply" op. */
export const AUDIO_TARGET_LUFS: Record<AudioCleanTarget, number> = {
  social: -16,
  youtube: -14,
  podcast: -16,
};

export interface UseAudioCleanResult {
  readonly cleans: readonly AudioClean[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly starting: boolean;
  readonly start: (params: {
    strength: AudioCleanStrength;
    target: AudioCleanTarget;
    dereverb?: boolean;
    deesser?: boolean;
    mediaId?: string;
  }) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

/** Builds the `SetAudio` op payload for one clean; the caller enqueues it. */
export function applyCleanOp(clean: AudioClean): SetAudioCleanOp {
  return {
    clean: {
      enabled: true,
      cleanId: clean.id,
      targetLufs: AUDIO_TARGET_LUFS[clean.target],
    },
  };
}

/** The op that turns "apply to export" back off. */
export function clearCleanOp(): SetAudioCleanOp {
  return { clean: { enabled: false, cleanId: null, targetLufs: 0 } };
}

export function useAudioClean(projectId: string): UseAudioCleanResult {
  const client = useApiClient();
  const [cleans, setCleans] = React.useState<readonly AudioClean[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const result = await client.call(audioEndpoints.cleans, { params: { projectId } });
      setCleans(result.cleans);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "could not load audio cleans");
    } finally {
      setLoading(false);
    }
  }, [client, projectId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasOpenRun = cleans.some(
    (clean) => clean.status === "queued" || clean.status === "running",
  );
  React.useEffect(() => {
    if (!hasOpenRun) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasOpenRun, refresh]);

  const start = React.useCallback<UseAudioCleanResult["start"]>(
    async (params) => {
      setStarting(true);
      setError(undefined);
      try {
        await client.call(audioEndpoints.clean, { params: { projectId }, body: params });
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "could not start the clean");
      } finally {
        setStarting(false);
      }
    },
    [client, projectId, refresh],
  );

  return { cleans, loading, error, starting, start, refresh };
}
