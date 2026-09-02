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

import { resolveOnboardingExportPreset } from "./onboarding-preset";
import { SubtitlesTab, type SubtitlesTabValue } from "./SubtitlesTab";
import { ToEditorTab } from "./ToEditorTab";
import { useExportDialog } from "./use-export-dialog";
import { VideoTab, type VideoTabValue } from "./VideoTab";
import { WatermarkNotice } from "./WatermarkNotice";

import { isBrowserExportEligible } from "@/lib/export";

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
}

const DEFAULT_VIDEO: VideoTabValue = { preset: "reels", script: "roman", dropFillers: false };
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

  const busy =
    state.phase === "probing" ||
    state.phase === "requesting" ||
    state.phase === "rendering" ||
    state.phase === "completing";

  const onExportVideo = React.useCallback(() => {
    void startExport({
      kind: "video",
      preset: video.preset,
      script: video.script,
      dropFillers: video.dropFillers,
      mode: "auto",
    });
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
    void startExport({
      kind: "video",
      preset: video.preset,
      script: video.script,
      dropFillers: video.dropFillers,
      mode: "browser",
    });
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

        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
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
            <WatermarkNotice
              watermarked={state.response?.watermarked}
              reasons={state.response?.reasons}
              onCleanManifestReady={onExportVideo}
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

        {state.phase === "cloud-offered" ? (
          <div
            className="mt-4 flex items-start gap-2 rounded-md bg-amber-400/10 p-3 text-xs text-amber-200"
            data-testid="export-cloud-offer"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">This export renders in the cloud.</p>
              {state.response?.reasons.map((reason, index) => (
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

        <DialogFooter>
          {state.phase === "rendering" ? (
            <Button variant="secondary" onClick={cancel} data-testid="export-cancel">
              Cancel
            </Button>
          ) : (
            <Button
              onClick={tab === "video" ? onExportVideo : onExportSubtitles}
              disabled={busy || tab === "to-editor"}
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
