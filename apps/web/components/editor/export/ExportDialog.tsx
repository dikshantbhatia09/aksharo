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

import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
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

import { SubtitlesTab, type SubtitlesTabValue } from "./SubtitlesTab";
import { ToEditorTab } from "./ToEditorTab";
import { useExportDialog } from "./use-export-dialog";
import { VideoTab, type VideoTabValue } from "./VideoTab";
import { WatermarkNotice } from "./WatermarkNotice";

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
  readonly fetchWatermarkAsset?: (assetId: string) => Promise<Uint8Array>;
  readonly resolveSourceUrl: (manifest: RenderManifest) => Promise<string>;
}

const DEFAULT_VIDEO: VideoTabValue = { preset: "reels", script: "roman", dropFillers: false };
const DEFAULT_SUBTITLES: SubtitlesTabValue = { formats: ["srt"], scripts: ["roman"] };

export function ExportDialog(props: ExportDialogProps): React.JSX.Element {
  const { open, onOpenChange } = props;
  const [tab, setTab] = React.useState<"video" | "subtitles" | "to-editor">("video");
  const [video, setVideo] = React.useState<VideoTabValue>(DEFAULT_VIDEO);
  const [subtitles, setSubtitles] = React.useState<SubtitlesTabValue>(DEFAULT_SUBTITLES);

  const { state, startExport, cancel, reset } = useExportDialog({
    projectId: props.projectId,
    projection: props.projection,
    catalogue: props.catalogue,
    registry: props.registry,
    shaper: props.shaper,
    resolveSourceUrl: props.resolveSourceUrl,
    ...(props.fetchWatermarkAsset === undefined
      ? {}
      : { fetchWatermarkAsset: props.fetchWatermarkAsset }),
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
            <VideoTab value={video} onChange={setVideo} disabled={busy} />
            <WatermarkNotice
              watermarked={state.response?.watermarked}
              reasons={state.response?.reasons}
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
