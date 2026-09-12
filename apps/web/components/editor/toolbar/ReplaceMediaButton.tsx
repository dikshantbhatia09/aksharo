"use client";

/**
 * K04: Replace-media (README recon §3 — "No Replace-media button anywhere,
 * grepped, zero hits").
 *
 * The brief's instruction was to check `03-architecture/07-api-and-contracts.md`
 * and the projects/media API for a "replace source media" op before building
 * any new backend surface. One already exists, complete:
 * `POST /projects/{id}/media/{mediaId}/replace` (`endpoints.media.replace`,
 * `apps/api/src/media/media.controller.ts`'s `replace()`) returns a fresh
 * multipart `UploadTicket` for the SAME media row; `MediaService.replace`
 * flags it `needsRealign` so the words survive and only their timings are
 * re-aligned once the new bytes are probed (`apps/api/test/replace-media.e2e-
 * spec.ts` exercises the whole pipeline). So this button is fully wired, not
 * disabled — the upload engine is the same one `apps/web/lib/upload`'s
 * `MultipartUpload`/`uploadPart` already drive for a first-time upload; this
 * component only supplies the trigger, the file picker and the completion
 * call, reusing rather than re-implementing the transport.
 */
import { Loader2, Replace } from "lucide-react";
import * as React from "react";

import { endpoints, useApiClient, useCompleteMediaUpload } from "@montaj/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ProgressBar,
  toast,
} from "@montaj/ui";

import { MultipartUpload } from "@/lib/upload/multipart-upload";
import { cn } from "@/lib/utils";

const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,audio/*";

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "uploading"; readonly percent: number }
  | { readonly kind: "finishing" }
  | { readonly kind: "error"; readonly message: string };

export function ReplaceMediaButton({
  projectId,
  mediaId,
  className,
}: {
  readonly projectId: string;
  readonly mediaId: string | undefined;
  readonly className?: string;
}): React.JSX.Element {
  const client = useApiClient();
  const completeUpload = useCompleteMediaUpload();
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState<Stage>({ kind: "idle" });
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const busy = stage.kind === "uploading" || stage.kind === "finishing";

  async function onFileChosen(file: File): Promise<void> {
    if (mediaId === undefined) return;
    setStage({ kind: "uploading", percent: 0 });
    try {
      const ticket = await client.call(endpoints.media.replace, {
        params: { projectId, mediaId },
        body: {
          filename: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
        },
      });

      const upload = new MultipartUpload({
        file,
        parts: ticket.parts,
        partSizeBytes: ticket.partSizeBytes,
        onProgress: (progress) => {
          const percent =
            progress.totalBytes > 0 ? (progress.uploadedBytes / progress.totalBytes) * 100 : 0;
          setStage({ kind: "uploading", percent });
        },
      });
      const completedParts = await upload.run();

      setStage({ kind: "finishing" });
      await completeUpload.mutateAsync({
        projectId,
        mediaId: ticket.media.id,
        body: {
          etags: completedParts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => part.etag),
        },
      });

      toast.success("New media uploaded", {
        description:
          "Re-aligning your captions to the new bytes now — the words stay, only the timings move.",
      });
      setOpen(false);
      setStage({ kind: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not replace the media.";
      setStage({ kind: "error", message });
    }
  }

  const disabledReason =
    mediaId === undefined ? "This project has no source media to replace yet." : undefined;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabledReason !== undefined}
        title={disabledReason ?? "Swap this project's source video, keeping captions and edits"}
        className={cn(
          "bg-bg-2 border-border text-fg-1 hover:text-fg-0 disabled:text-fg-disabled flex h-8 items-center gap-1.5 rounded-sm border px-3 text-xs font-medium transition-colors duration-[160ms] disabled:cursor-not-allowed",
          className,
        )}
        onClick={() => {
          setStage({ kind: "idle" });
          setOpen(true);
        }}
        data-testid="replace-media-button"
      >
        <Replace className="size-3.5" aria-hidden="true" />
        {/* A 9:16 project's preview column commonly runs under ~250px wide
            (measured 2026-09-12) — too narrow for this pill and the Safe
            zone/Res pills on the opposite corner to both carry full labels.
            Icon-only below that; the button's own `title` already carries
            the full description. */}
        <span className="hidden @min-[340px]:inline">Replace</span>
      </Button>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent data-testid="replace-media-dialog">
          <DialogHeader>
            <DialogTitle>Replace media</DialogTitle>
            <DialogDescription>
              Upload a new video or audio file for this project. Your transcript, captions and edits
              stay exactly as they are — only the word timings are re-aligned to the new file once
              it is uploaded.
            </DialogDescription>
          </DialogHeader>

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            data-testid="replace-media-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void onFileChosen(file);
            }}
          />

          {stage.kind === "idle" ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => inputRef.current?.click()}
              data-testid="replace-media-choose-file"
            >
              Choose a file…
            </Button>
          ) : null}

          {stage.kind === "uploading" ? (
            <div className="flex flex-col gap-2" data-testid="replace-media-progress">
              <ProgressBar value={stage.percent} label={`${Math.round(stage.percent)}% uploaded`} />
              <p className="text-fg-2 text-xs">Uploading… {Math.round(stage.percent)}%</p>
            </div>
          ) : null}

          {stage.kind === "finishing" ? (
            <p className="text-fg-2 flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Finishing up…
            </p>
          ) : null}

          {stage.kind === "error" ? (
            <p role="alert" className="text-rejected text-xs" data-testid="replace-media-error">
              {stage.message}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
