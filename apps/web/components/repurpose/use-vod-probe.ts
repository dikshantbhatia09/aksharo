"use client";

/**
 * Livestream & VOD fast metadata and chat replay probe hook (Pillar 1 §05).
 *
 * Sends a debounced request to the API's `/media/probe-vod` endpoint to fetch
 * VOD title, duration, chat velocity graph, and highlight candidate peaks.
 * Uses `useOptionalApiClient` so standalone unit tests and harnesses without
 * `<ApiProvider>` remain graceful and do not fail.
 */
import * as React from "react";
import { defineEndpoint, useOptionalApiClient } from "@montaj/api-client";
import type { VodProbeResponse } from "@montaj/repurpose-contracts";
import {
  isLivestreamLink,
  isPlausibleLink,
  linkSite,
  normaliseSourceLink,
} from "@/components/repurpose/source-link";

export const vodProbeEndpoint = defineEndpoint<
  { readonly url: string },
  VodProbeResponse
>({
  method: "POST",
  path: "/media/probe-vod",
  auth: "bearer",
});

export interface VodProbeState {
  readonly data: VodProbeResponse | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

export function useVodProbe(rawUrl: string): VodProbeState {
  const client = useOptionalApiClient();
  const [data, setData] = React.useState<VodProbeResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  const normalised = normaliseSourceLink(rawUrl);
  const isCandidate =
    isPlausibleLink(normalised) &&
    (isLivestreamLink(normalised) || ["twitch", "kick"].includes(linkSite(normalised) ?? ""));

  React.useEffect(() => {
    if (!client || !isCandidate || normalised === "") {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);

    client
      .call(vodProbeEndpoint, {
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
  }, [client, isCandidate, normalised]);

  return {
    data,
    isLoading,
    isError: error !== null,
    error,
  };
}
