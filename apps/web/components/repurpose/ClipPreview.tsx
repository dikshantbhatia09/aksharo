"use client";

import * as React from "react";

import { defineEndpoint, useRawApiClient } from "@montaj/api-client";

/**
 * `GET /projects/{projectId}/transcript/export` — the clip project's captions,
 * built from its editing document, so an edit in the editor shows up here too.
 */
const exportTranscript = defineEndpoint<void, unknown>({
  method: "GET",
  path: "/projects/{projectId}/transcript/export",
  auth: "bearer",
});

/**
 * A cut clip on the run page: the clean 9:16 picture with its captions laid over
 * it as a native WebVTT text track.
 *
 * The mezzanine used to have captions burned into the picture, which is how this
 * preview showed them — and why the clip's own project, whose editor draws the
 * captions, showed two sets (2026-09-25). The picture is clean now; the captions
 * come from the clip project, and a preview whose captions cannot be fetched
 * still plays, just without them.
 */
export function ClipPreview({
  videoUrl,
  projectId,
  label,
  testId,
}: {
  readonly videoUrl: string;
  /** The clip's own project; without one the preview has no captions to show. */
  readonly projectId: string | undefined;
  /** The video's accessible name. */
  readonly label?: string;
  readonly testId: string;
}): React.JSX.Element {
  const client = useRawApiClient();
  const [trackUrl, setTrackUrl] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    if (projectId === undefined) return undefined;
    let cancelled = false;
    let objectUrl: string | undefined;
    client
      .callText(exportTranscript, { params: { projectId }, query: { format: "vtt" } })
      .then((vtt) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        setTrackUrl(objectUrl);
      })
      .catch(() => {
        // Captions are a courtesy on a preview; the clip still plays without them.
      });
    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, projectId]);

  return (
    <video
      src={videoUrl}
      controls
      playsInline
      {...(label === undefined ? {} : { "aria-label": label })}
      className="clip-preview aspect-[9/16] w-full object-cover"
      data-testid={testId}
    >
      {trackUrl === undefined ? null : (
        <track
          kind="captions"
          src={trackUrl}
          srcLang="und"
          label="Captions"
          default
          data-testid={`${testId}-captions`}
        />
      )}
    </video>
  );
}
