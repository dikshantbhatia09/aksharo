"use client";

import { Loader2, Play } from "lucide-react";
import * as React from "react";

import { defineEndpoint, useProjectRenderPreview, useRawApiClient } from "@montaj/api-client";
import type { EdgProjection } from "@montaj/render-core";

import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { aspectRatioOf } from "@/components/editor/canvas/stage-fit";
import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { signedLifetimeMs, useStableUrl } from "@/components/repurpose/use-stable-url";
import { useFaceTrack } from "@/lib/edg/use-face-track";

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
 * How much signed life a proxy URL must have left for a stage to start on it:
 * more than a clip (three minutes at most) takes to play through. With less,
 * the render preview is fetched again first. A clip played long after the page
 * loaded used to start on a URL that no longer worked: a black stage, and no
 * fallback, because the query itself had succeeded.
 */
export const PLAY_MIN_LIFE_MS = 4 * 60_000;

/**
 * A URL's lifetime when it does not say (`X-Amz-Expires`): the shortest the API
 * signs a preview for, the public viewer's five minutes.
 */
const ASSUMED_URL_LIFETIME_MS = 5 * 60_000;

/** Whether a URL fetched at `fetchedAt` still has enough life at `now` to start playing. */
export function lastsForPlayback(url: string | undefined, fetchedAt: number, now: number): boolean {
  const lifetimeMs =
    (url === undefined ? undefined : signedLifetimeMs(url)) ?? ASSUMED_URL_LIFETIME_MS;
  return fetchedAt + lifetimeMs - now >= PLAY_MIN_LIFE_MS;
}

/** Toggles native controls on the `<video>` `CaptionStage` mounts, as the share viewer does. */
function usePlaybackControls(containerRef: React.RefObject<HTMLDivElement | null>): void {
  React.useEffect(() => {
    const video = containerRef.current?.querySelector("video");
    if (video === null || video === undefined) return;
    video.controls = true;
  });
}

/**
 * A cut clip on the run page, drawn the way it will export.
 *
 * The preview used to be the clean picture with the clip's captions laid over it
 * as a native WebVTT track: the browser's own font, at the bottom, over any face
 * — not the run's caption style, and not where the export puts it (clips
 * hardening, 2026-09-26). It now renders through the editor's `CaptionStage`
 * from the clip project's render preview — its proxy, its editing document's
 * projection and its face track — with the system style catalogue, exactly as
 * the share page does, so what is reviewed here is what gets exported.
 *
 * Two things keep that affordable on a page of several clips:
 *
 *   * only the ACTIVE clip mounts a stage (CanvasKit, a WebGL surface and a
 *     preloading proxy each) and waits for its face track; the others show
 *     their first frame and a play button, and pressing it makes that clip the
 *     active one — on URLs with enough life left to play ({@link PLAY_MIN_LIFE_MS});
 *   * a clip whose preview is not ready yet — no proxy (409), no editing
 *     document, or any error — falls back to the plain clip with its WebVTT
 *     captions, which is still a faithful picture, just not a styled one.
 */
export function ClipPreview({
  videoUrl,
  projectId,
  label,
  testId,
  active,
  onActivate,
}: {
  readonly videoUrl: string;
  /** The clip's own project; without one the preview has no captions to show. */
  readonly projectId: string | undefined;
  /** The video's accessible name. */
  readonly label?: string;
  readonly testId: string;
  /**
   * Whether this clip holds the page's one live stage. Uncontrolled when
   * omitted: the preview then activates itself on its own play button.
   */
  readonly active?: boolean;
  readonly onActivate?: () => void;
}): React.JSX.Element {
  const client = useRawApiClient();
  const [selfActive, setSelfActive] = React.useState(false);
  const isActive = active ?? selfActive;
  const stageRef = React.useRef<HTMLDivElement>(null);
  /** When play was last pressed here; `null` while it never has been. */
  const [playAt, setPlayAt] = React.useState<number | null>(null);

  // Only the clip being played waits for its face track (see the hook).
  const preview = useProjectRenderPreview(projectId, { wantFaces: isActive });
  const projection = (preview.data?.projection ?? null) as EdgProjection | null;
  // Play was pressed on data too old to trust its URLs; a fresh copy is on its way.
  const awaitingFresh =
    isActive &&
    playAt !== null &&
    !lastsForPlayback(preview.data?.proxyUrl, preview.dataUpdatedAt, playAt);
  // ...and it failed to come: the plain clip plays instead of a black stage.
  const refreshFailed = awaitingFresh && playAt !== null && preview.errorUpdatedAt >= playAt;
  // From the data, not the query's status: a refetch that fails after a success
  // (a 5xx, a 409 while the clip is re-probed) keeps the data, and used to swap
  // the stage someone was watching for the plain video mid-play.
  const styled = projection !== null && !refreshFailed;
  const live = isActive && styled && !awaitingFresh;
  // Each poll presigns afresh; a new `src` would restart the playing stage, so
  // the URLs are held while the stage is live, and the freshest used before.
  const proxyUrl = useStableUrl(preview.data?.proxyUrl, undefined, { hold: live });
  const facesUrl = useStableUrl(preview.data?.facesUrl, undefined, { hold: live });
  // Captions keep off faces here exactly as they do in the export. Only the
  // active clip fetches its track: the others draw nothing yet.
  const faces = useFaceTrack(live ? facesUrl : undefined, projection?.canvas);
  usePlaybackControls(stageRef);

  // The WebVTT track is the fallback's captions, so it is only fetched once the
  // styled preview is known not to be available (still being prepared, or
  // failed) — never for a clip that will draw its own.
  const [trackUrl, setTrackUrl] = React.useState<string | undefined>(undefined);
  const needsTrack = projectId !== undefined && !preview.isPending && !styled;
  React.useEffect(() => {
    if (!needsTrack || projectId === undefined) return undefined;
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
  }, [client, projectId, needsTrack]);

  const activate = (): void => {
    const now = Date.now();
    setPlayAt(now);
    if (!lastsForPlayback(preview.data?.proxyUrl, preview.dataUpdatedAt, now)) {
      void preview.refetch();
    }
    if (onActivate === undefined) setSelfActive(true);
    else onActivate();
  };

  if (live && projection !== null && proxyUrl !== undefined) {
    return (
      <div
        ref={stageRef}
        className="clip-preview w-full"
        style={{ aspectRatio: aspectRatioOf(projection.canvas) }}
        data-testid={testId}
        data-preview="styled"
        role="group"
        {...(label === undefined ? {} : { "aria-label": label })}
      >
        <CaptionStage
          src={proxyUrl}
          projection={projection}
          {...(faces === undefined ? {} : { faces })}
          catalogue={SYSTEM_STYLE_MAP}
          showSafeZones={false}
          // Pressing play on the poster is what mounted this stage.
          playing
          // Paused past its URL's expiry and played again, the next range
          // request is refused: a fresh copy replaces the held one, which is
          // past its renewal point by then (`useStableUrl`).
          onMediaError={() => {
            void preview.refetch();
          }}
        />
      </div>
    );
  }

  if (styled) {
    return (
      <button
        type="button"
        onClick={activate}
        disabled={awaitingFresh}
        aria-busy={awaitingFresh}
        className="group relative block aspect-[9/16] w-full"
        aria-label={label === undefined ? "Play with captions" : `Play with captions: ${label}`}
        data-testid={`${testId}-play`}
      >
        {/* The clip's first frame as its poster; the stage mounts on play. */}
        <video
          src={videoUrl}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          aria-hidden="true"
          className="clip-preview h-full w-full object-cover"
          data-testid={testId}
          data-preview="poster"
        />
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <span className="flex size-11 items-center justify-center rounded-full bg-bg-0/80 text-fg-0 transition-colors duration-[160ms] group-hover:bg-bg-2">
            {awaitingFresh ? (
              <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Play className="size-5" strokeWidth={1.75} />
            )}
          </span>
        </span>
      </button>
    );
  }

  return (
    <video
      src={videoUrl}
      controls
      playsInline
      {...(label === undefined ? {} : { "aria-label": label })}
      className="clip-preview aspect-[9/16] w-full object-cover"
      data-testid={testId}
      data-preview="plain"
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
