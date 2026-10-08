"use client";

/**
 * YouTube fast metadata probe hook (Pillar 4 §01).
 *
 * Sends a debounced request to the API's `/media/probe-url` endpoint to fetch
 * thumbnail, channel, duration, and native chapters for instant UX feedback.
 * Uses `useOptionalApiClient` so standalone unit tests and harnesses without
 * `<ApiProvider>` remain graceful and do not fail.
 */
import * as React from "react";
import { defineEndpoint, useOptionalApiClient } from "@montaj/api-client";
import type { YouTubeProbeResponse } from "@montaj/repurpose-contracts";
import { isPlausibleLink, linkSite, normaliseSourceLink } from "@/components/repurpose/source-link";

export const youtubeProbeEndpoint = defineEndpoint<
  { readonly url: string },
  YouTubeProbeResponse
>({
  method: "POST",
  path: "/media/probe-url",
  auth: "bearer",
});

export interface YouTubeProbeState {
  readonly data: YouTubeProbeResponse | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

export function useYouTubeProbe(rawUrl: string): YouTubeProbeState {
  const client = useOptionalApiClient();
  const [data, setData] = React.useState<YouTubeProbeResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  const normalised = normaliseSourceLink(rawUrl);
  const isYouTube =
    isPlausibleLink(normalised) &&
    (linkSite(normalised) ?? "youtube") === "youtube";

  React.useEffect(() => {
    if (!client || !isYouTube || normalised === "") {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);

    client
      .call(youtubeProbeEndpoint, {
        body: { url: normalised },
      })
      .then((res) => {
        if (active) {
          setData(res);
          setIsLoading(false);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [client, isYouTube, normalised]);

  return {
    data,
    isLoading,
    isError: error !== null,
    error,
  };
}
