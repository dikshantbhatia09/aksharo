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
  /**
   * K03: `media_assets.thumb_keys`, presigned — worker-media's evenly-spaced
   * filmstrip (`apps/worker-media/src/ffmpeg/derive.ts`'s `THUMBNAIL_COUNT`),
   * already returned by this same endpoint (`@montaj/api-client`'s own
   * canonical `MediaUrls` type has carried `thumbs` since A06) but dropped by
   * this file's local duplicate of that type until the timeline had a lane
   * that needed it.
   */
  readonly thumbs?: readonly string[];
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
  /** K03: presigned thumbnail URLs, for `Timeline.tsx`'s filmstrip lane. */
  readonly thumbs: readonly string[] | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => void;
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
  const [thumbs, setThumbs] = useState<readonly string[] | undefined>(undefined);
  const [loading, setLoading] = useState(mediaId !== undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (mediaId === undefined) {
      setProxyUrl(undefined);
      setWaveform(undefined);
      setThumbs(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const urls = await client.call(getMediaUrls, { params: { projectId, mediaId } });
        if (cancelled) return;
        setProxyUrl(urls.proxy);
        setThumbs(urls.thumbs);
        if (urls.waveform !== undefined) {
          const response = await fetch(urls.waveform);
          if (!response.ok) throw new Error(`waveform fetch failed: ${String(response.status)}`);
          const parsed = (await response.json()) as WaveformLike;
          if (!cancelled) setWaveform(parsed);
        } else if (!cancelled) {
          setWaveform(undefined);
        }
        // Signed URLs are short-lived on purpose (they leak into logs and bug
        // reports). Re-sign at 80% of the TTL so the <video> never holds an
        // expired src; a hidden tab skips the timer and refreshes on return.
        const ttlMs = new Date(urls.expiresAt).getTime() - Date.now();
        if (Number.isFinite(ttlMs) && ttlMs > 0) {
          timer = setTimeout(
            () => {
              if (!cancelled && document.visibilityState === "visible") {
                setNonce((n) => n + 1);
              }
            },
            Math.max(15_000, ttlMs * 0.8),
          );
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
    const onVisible = (): void => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, projectId, mediaId, nonce]);

  return { proxyUrl, waveform, thumbs, loading, error, refresh: () => setNonce((n) => n + 1) };
}
