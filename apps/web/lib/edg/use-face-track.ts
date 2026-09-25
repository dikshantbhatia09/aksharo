"use client";

/**
 * A media's face track (`faces.json`, from `ai.faces`) mapped onto a canvas, for
 * a `CaptionStage` that is not the editor's — the share viewer. The editor gets
 * the same file through `useTimelineMedia`.
 */

import { useEffect, useMemo, useState } from "react";

import {
  type CanvasFaceTrack,
  type FaceTrackDocument,
  faceTrackOnCanvas,
  parseFaceTrack,
} from "@montaj/render-core";

export function useFaceTrack(
  url: string | undefined,
  canvas: { readonly width: number; readonly height: number } | undefined,
): CanvasFaceTrack | undefined {
  const [doc, setDoc] = useState<FaceTrackDocument | undefined>(undefined);
  useEffect(() => {
    if (url === undefined) return undefined;
    let cancelled = false;
    // Best effort: without a track, captions sit where their style puts them.
    fetch(url)
      .then(async (response) => (response.ok ? parseFaceTrack(await response.json()) : undefined))
      .then((track) => {
        if (!cancelled && track !== undefined) setDoc(track);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);
  return useMemo(
    () => (doc === undefined || canvas === undefined ? undefined : faceTrackOnCanvas(doc, canvas)),
    [doc, canvas],
  );
}
