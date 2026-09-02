"use client";

/**
 * Fetches the two things the timeline draws from A06/A07's derived media: the
 * proxy URL (for `CaptionStage`'s `<video>`) and `waveform.json` (peaks
 * 100/s, RMS 10/s — `apps/worker-media/src/waveform.ts`). `GET
 * /projects/{projectId}/media/{mediaId}/urls` is not yet in
 * `@montaj/api-client`'s curated `endpoints.ts` (that package is outside this
 * work package's file boundary), so this uses the client's own documented
 * escape hatch — `defineEndpoint` + `useRawApiClient()` — "for a call the
 * hooks do not cover yet", exactly this situation.
 */
import { useEffect, useState } from "react";

import { defineEndpoint, useRawApiClient } from "@montaj/api-client";

import type { WaveformLike } from "./waveform-view";

export interface MediaUrls {
  readonly mediaId: string;
  readonly proxy?: string;
  readonly waveform?: string;
  readonly expiresAt: string;
}

const getMediaUrls = defineEndpoint<void, MediaUrls>({
  method: "GET",
  path: "/projects/{projectId}/media/{mediaId}/urls",
  auth: "bearer",
});

export interface TimelineMedia {
  readonly proxyUrl: string | undefined;
  readonly waveform: WaveformLike | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
}

/**
 * `undefined` mediaId (no primary media yet) is a valid, quiet no-op state —
 * a brand-new project with a still-processing upload should not show an
 * error banner over the timeline.
 */
export function useTimelineMedia(projectId: string, mediaId: string | undefined): TimelineMedia {
  const client = useRawApiClient();
  const [proxyUrl, setProxyUrl] = useState<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<WaveformLike | undefined>(undefined);
  const [loading, setLoading] = useState(mediaId !== undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (mediaId === undefined) {
      setProxyUrl(undefined);
      setWaveform(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const urls = await client.call(getMediaUrls, { params: { projectId, mediaId } });
        if (cancelled) return;
        setProxyUrl(urls.proxy);
        if (urls.waveform !== undefined) {
          const response = await fetch(urls.waveform);
          if (!response.ok) throw new Error(`waveform fetch failed: ${String(response.status)}`);
          const parsed = (await response.json()) as WaveformLike;
          if (!cancelled) setWaveform(parsed);
        } else if (!cancelled) {
          setWaveform(undefined);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Could not load media for the timeline.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, mediaId]);

  return { proxyUrl, waveform, loading, error };
}
