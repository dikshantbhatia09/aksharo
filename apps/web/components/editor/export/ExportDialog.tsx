"use client";

/**
 * Export dialog (`08-ux-design-system.md` §4 v2): Video / Subtitles / To
 * editor tabs, preset picker, watermark notice, credit cost, progress and
 * cancel, a results list. Never silently switches browser → cloud: a
 * downgrade always shows `response.reasons` and requires the reader to
 * notice, not a background switch mid-render.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import * as React from "react";

import { useCurrentUser } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import { BRAND } from "@montaj/config";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressBar,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@montaj/ui";

import { ExportHistory } from "./ExportHistory";
import { resolveOnboardingExportPreset } from "./onboarding-preset";
import { SubtitlesTab, type SubtitlesTabValue } from "./SubtitlesTab";
import { ToEditorTab } from "./ToEditorTab";
import { useExportDialog } from "./use-export-dialog";
import { VideoTab, type VideoTabValue } from "./VideoTab";
import { WatermarkNotice } from "./WatermarkNotice";
import { LocalModeNotice } from "../local-mode-gate";

import { isBrowserExportEligible } from "@/lib/export";

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
  /**
   * Brief C04b §3: a local project cannot fall back to the cloud renderer
   * (C04 "no uploads of any kind") — when this export needs the cloud path
   * (`state.phase === "cloud-offered"`), the dialog shows the "upload to
   * cloud" affordance instead of the normal cloud offer, so exporting a
   * clip too big/slow for this browser has an honest next step rather than
   * a silent upload. Undefined/`false` behaves exactly as before this WP.
   */
  readonly isLocalProject?: boolean;
  readonly onUploadToCloud?: () => void;
  readonly uploadingToCloud?: boolean;
}

const DEFAULT_VIDEO: VideoTabValue = {
  preset: "reels",
  script: "roman",
  dropFillers: false,
  // K07: 100%, matching the reference frame's default — every export before
  // this field existed is unaffected (see VideoTabValue's doc comment).
  captionOpacity: 1,
};
const DEFAULT_SUBTITLES: SubtitlesTabValue = { formats: ["srt"], scripts: ["roman"] };

export function ExportDialog(props: ExportDialogProps): React.JSX.Element {
  const { open, onOpenChange } = props;
  const [tab, setTab] = React.useState<"video" | "subtitles" | "to-editor">("video");
  const [video, setVideo] = React.useState<VideoTabValue>(DEFAULT_VIDEO);
  const [subtitles, setSubtitles] = React.useState<SubtitlesTabValue>(DEFAULT_SUBTITLES);

  // B17 preset: pre-select the preset `me.onboarding.defaultExportPreset`
  // names, once, the first time it becomes available — a manual choice
  // (`onVideoChange` below) marks this done so a later refetch of `me` can
  // never overwrite what the user picked.
  const me = useCurrentUser();
  const appliedOnboardingPreset = React.useRef(false);
  React.useEffect(() => {
    if (appliedOnboardingPreset.current) return;
    const defaultExportPreset = me.data?.onboarding?.defaultExportPreset;
    if (defaultExportPreset === undefined) return;
    appliedOnboardingPreset.current = true;
    const named = resolveOnboardingExportPreset(defaultExportPreset);
    setVideo((v) => ({ ...v, preset: named.preset }));
  }, [me.data]);

  const onVideoChange = React.useCallback((next: VideoTabValue) => {
    appliedOnboardingPreset.current = true;
    setVideo(next);
  }, []);

  const { state, startExport, cancel, reset } = useExportDialog({
    projectId: props.projectId,
    projection: props.projection,
    catalogue: props.catalogue,
    registry: props.registry,
    shaper: props.shaper,
  });

  // S-02 (addendum 3): a render this dialog is NOT following can still be
  // running - close it mid-render and the phase state is reset. The history
  // below knows, because it polls the project's render jobs; without this the
  // reopened dialog offers a fresh Export button over a render already in
  // flight, which is a second credit hold for a file the reader is waiting for.
  const [renderInFlight, setRenderInFlight] = React.useState(false);

  const busy =
    state.phase === "probing" ||
    state.phase === "requesting" ||
    state.phase === "rendering" ||
    // A cloud render is as busy as a local one — the preset that produced it
    // must not change under the reader while the file is being made (F06-4).
    state.phase === "cloud-rendering" ||
    state.phase === "completing";

  /**
   * FIX-06: `response.reasons` is one list with one meaning, and the offered
   * state printed it twice — the watermark notice above and the cloud panel
   * below both map the same array (the audit's "three explanatory lines,
   * twice"). One owner: the cloud panel while it is on screen, because there
   * the reasons answer the question that panel asks; the notice otherwise.
   * De-duplication only — the wording is untouched, FIX-07 owns the copy.
   */
  const cloudOfferShown = state.phase === "cloud-offered" && props.isLocalProject !== true;
  const reasons = state.response?.reasons;

  const onExportVideo = React.useCallback(() => {
    void startExport(
      {
        kind: "video",
        preset: video.preset,
        script: video.script,
        dropFillers: video.dropFillers,
        mode: "auto",
      },
      // K07: caption opacity is a browser-render-time-only option, deliberately
      // kept out of `CreateExportRequest` — see `use-export-dialog.ts`'s
      // `startExport` doc comment for why it is not part of the wire request.
      { captionOpacity: video.captionOpacity },
    );
  }, [startExport, video]);

  // A19c ruling (2): `auto` defaults 1080p-and-up to the cloud when this
  // browser has no hardware video encoder (`decision.ts`'s
  // `SOFTWARE_ENCODER_CLOUD_DEFAULT_REASON`). An explicit `mode: "browser"`
  // request overrides that default — offered only when the client's own
  // probe says the browser path is otherwise workable at all
  // (`isBrowserExportEligible`), so this never appears for a genuinely
  // ineligible browser (no WebCodecs, mobile, etc.).
  const softwareEncoderCloudDefault =
    state.phase === "cloud-offered" &&
    state.response?.path === "cloud" &&
    state.probe !== null &&
    isBrowserExportEligible(state.probe) &&
    (state.response.reasons ?? []).some((reason) => /hardware/i.test(reason));

  const onExportVideoBrowserAnyway = React.useCallback(() => {
    void startExport(
      {
        kind: "video",
        preset: video.preset,
        script: video.script,
        dropFillers: video.dropFillers,
        mode: "browser",
      },
      { captionOpacity: video.captionOpacity },
    );
  }, [startExport, video]);

  const onExportSubtitles = React.useCallback(() => {
    void startExport({
      kind: "subtitle",
      subtitle: { formats: subtitles.formats, scripts: subtitles.scripts },
      mode: "browser",
    });
  }, [startExport, subtitles]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="export-dialog">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            // The result/error banner below is rendered once for the whole
            // dialog, not per tab (it sits outside `TabsContent`), so a failed
            // Video attempt -- "the source has no video track" for an
            // audio-only project, say -- otherwise keeps showing over
            // Subtitles or To editor until the reader starts another export,
            // implying a format that has nothing to do with video is about to
            // fail too. Only when nothing is actually in flight: `busy` mid
            // render or mid cloud-follow must survive a tab click untouched.
            if (!busy) reset();
            setTab(value as typeof tab);
          }}
        >
          <TabsList>
            <TabsTrigger value="video" data-testid="export-tab-video">
              Video
            </TabsTrigger>
            <TabsTrigger value="subtitles" data-testid="export-tab-subtitles">
              Subtitles
            </TabsTrigger>
            <TabsTrigger value="to-editor" data-testid="export-tab-to-editor">
              To editor
            </TabsTrigger>
          </TabsList>

          <TabsContent value="video">
            <VideoTab value={video} onChange={onVideoChange} disabled={busy} />
            {/*
              FIX-06: this notice reacts to results; it must never CAUSE an
              export. One user click => one startExport call, from the submit
              handler only — the audit found this callback double-firing the
              action (two renders, two credit holds, still watermarked). The
              effect that fired it is the upsell panel's eligibility notifier
              (`upsell/ExportUpsellPanel.tsx`, the `useEffect` on
              `eligibility.data` calling `onCleanManifestReady`); it stays,
              because refreshing offer data is its legitimate job — it simply
              no longer reaches `startExport`. A clean path becoming available
              is now something the reader acts on with the Export button, not
              something that spends their credits for them.
            */}
            <WatermarkNotice
              watermarked={state.response?.watermarked}
              reasons={cloudOfferShown ? undefined : reasons}
            />
            {state.response?.quote !== undefined ? (
              <p className="text-fg-3 mt-2 text-xs" data-testid="export-quote">
                {state.response.quote.tenths === 0
                  ? "No credit cost — this browser renders it."
                  : `${state.response.quote.credits} credits`}
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="subtitles">
            <SubtitlesTab value={subtitles} onChange={setSubtitles} disabled={busy} />
          </TabsContent>

          <TabsContent value="to-editor">
            <ToEditorTab />
          </TabsContent>
        </Tabs>

        {state.phase === "rendering" && state.progress !== null ? (
          <div className="mt-4 space-y-2" data-testid="export-progress">
            <ProgressBar
              value={Math.round(state.progress.ratio * 100)}
              label={`${String(Math.round(state.progress.ratio * 100))}%`}
            />
            <p className="text-fg-3 text-xs">
              {state.progress.phase} — {state.progress.framesDone}/{state.progress.framesTotal}{" "}
              frames
            </p>
          </div>
        ) : null}

        {state.phase === "cloud-offered" && props.isLocalProject === true ? (
          <div className="mt-4" data-testid="export-cloud-offer-gated">
            <LocalModeNotice
              feature="cloud rendering"
              {...(props.onUploadToCloud === undefined
                ? {}
                : { onUploadToCloud: props.onUploadToCloud })}
              uploading={props.uploadingToCloud ?? false}
            />
          </div>
        ) : null}

        {state.phase === "cloud-rendering" ? (
          <div className="mt-4 flex flex-col gap-2" data-testid="export-cloud-progress">
            <p className="text-fg-1 text-sm font-medium">Rendering in the cloud…</p>
            {state.cloudJob?.status === "running" ? (
              <>
                <ProgressBar value={state.cloudJob.progress ?? 0} label="Cloud render progress" />
                <p className="text-fg-3 text-xs">
                  {state.cloudJob.progress === null
                    ? "In progress"
                    : `In progress — ${String(state.cloudJob.progress)}%`}
                </p>
              </>
            ) : (
              <p className="text-fg-3 text-xs">Waiting for a render worker…</p>
            )}
            <p className="text-fg-3 text-xs">You can close this dialog — the render continues.</p>
          </div>
        ) : null}

        {state.phase === "cloud-done" ? (
          <div className="mt-4 flex flex-col gap-2" data-testid="export-cloud-download">
            <p className="text-fg-1 text-sm font-medium">Your export is ready.</p>
            {state.downloadUrl === null ? (
              <p className="text-fg-3 text-xs">
                The file rendered, but no download link came back — find it under the project&apos;s
                exports.
              </p>
            ) : (
              <Button asChild data-testid="export-download">
                <a href={state.downloadUrl} target="_blank" rel="noreferrer">
                  Download file
                </a>
              </Button>
            )}
          </div>
        ) : null}

        {cloudOfferShown ? (
          <div
            className="mt-4 flex items-start gap-2 rounded-md bg-amber-400/10 p-3 text-xs text-amber-200"
            data-testid="export-cloud-offer"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">This export renders in the cloud.</p>
              {reasons?.map((reason, index) => (
                <p key={index}>{reason}</p>
              ))}
              {state.error !== null ? <p>{state.error}</p> : null}
              {softwareEncoderCloudDefault ? (
                <div className="mt-2">
                  <p className="text-amber-200/80">
                    Export directly in this browser instead — no upload to {BRAND.name}&apos;s cloud
                    renderer, but without a hardware video encoder it may be slow.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-1"
                    onClick={onExportVideoBrowserAnyway}
                    data-testid="export-browser-anyway"
                  >
                    Export in this browser anyway
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {state.phase === "cancelled" ? (
          <p className="text-fg-3 mt-4 text-xs" data-testid="export-cancelled">
            Export cancelled.
          </p>
        ) : null}

        {state.phase === "error" ? (
          <p className="mt-4 text-xs text-red-400" data-testid="export-error">
            {state.error}
          </p>
        ) : null}

        {state.phase === "done" && state.result !== null ? (
          <p className="mt-4 text-xs text-emerald-400" data-testid="export-done">
            Export finished — {(state.result.sizeBytes / (1024 * 1024)).toFixed(1)} MB,{" "}
            {(state.result.durationMs / 1000).toFixed(1)} s.
          </p>
        ) : null}

        <ExportHistory projectId={props.projectId} onActiveChange={setRenderInFlight} />

        {renderInFlight && state.phase !== "cloud-rendering" ? (
          <p className="text-fg-3 mt-3 text-xs" data-testid="export-render-in-flight">
            A render is already running — see Previous exports.
          </p>
        ) : null}

        <DialogFooter>
          {state.phase === "rendering" || state.phase === "cloud-rendering" ? (
            <Button variant="secondary" onClick={cancel} data-testid="export-cancel">
              Cancel
            </Button>
          ) : (
            <Button
              onClick={tab === "video" ? onExportVideo : onExportSubtitles}
              disabled={
                busy ||
                renderInFlight ||
                tab === "to-editor" ||
                (props.isLocalProject === true && state.phase === "cloud-offered")
              }
              data-testid="export-start"
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Export
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
