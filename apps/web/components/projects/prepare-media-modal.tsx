"use client";

/**
 * "Prepare Your Media" (K02 scope item 2; reference frames `frame_0020.png`
 * grouped view, `frame_0040.png` search view, `frame_0050.png`-`frame_0055.png`
 * the processing hand-off).
 *
 * Kalakar's version is one dialog that stays open across the whole trip —
 * pick a language and a writing script, "Generate Transcription", then the
 * same dialog turns into "Uploading…" and later "Analyzing"/"Generating"
 * panels with a rotating tip. This component follows that shape as closely as
 * our own upload architecture allows: it owns the language/script form, and
 * once `onGenerate` starts the (unchanged) upload+transcribe pipeline, the
 * caller feeds the newly created row's live {@link UploadItemState} back in
 * as `item` so the SAME dialog can keep narrating Uploading → Analyzing →
 * Generating for as long as the person leaves it open. Closing the dialog
 * (the X, Escape, or a click outside) never cancels the underlying job — it
 * is exactly the same `useUploadQueue` row the compact tray below still
 * shows; this is a presentational layer over that real state, never a second
 * copy of it.
 *
 * **The writing-script field is a client-side default, not a transcription
 * input.** See `writing-script-picker.tsx`'s file doc and this WP's
 * `REPORT.md` for the investigation that established that and exactly how
 * far the wiring reaches today.
 */
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Copy,
  FileVideo,
  Lock,
  ScanSearch,
  Smile,
  Sparkles,
  UploadCloud,
  Volume2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch,
} from "@montaj/ui";

import { LanguagePicker } from "./language-picker";
import { PROCESSING_TIPS, ProcessingScreen, useRotatingTip } from "./processing-tips";
import { WritingScriptPicker } from "./writing-script-picker";

import type { UploadItemState } from "@/lib/upload/types";

import { cn } from "@/lib/utils";


function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export interface PrepareMediaModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The file this dialog is preparing. `undefined` while nothing is pending. */
  readonly file: File | undefined;
  /** The upload queue's own row for `file`, once `onGenerate` has started it. */
  readonly item: UploadItemState | undefined;
  readonly initialLanguage: string | undefined;
  readonly initialScript: string | undefined;
  /** Kicks off the existing upload+transcribe flow, unchanged, with the chosen picks. */
  readonly onGenerate: (language: string, script: string) => void;
}

export function PrepareMediaModal({
  open,
  onOpenChange,
  file,
  item,
  initialLanguage,
  initialScript,
  onGenerate,
}: PrepareMediaModalProps): React.JSX.Element {
  const [language, setLanguage] = React.useState<string | undefined>(initialLanguage);
  const [script, setScript] = React.useState<string | undefined>(initialScript);
  const [audioEnhancement, setAudioEnhancement] = React.useState(false);
  const [autoEmojis, setAutoEmojis] = React.useState(false);
  const tip = useRotatingTip(PROCESSING_TIPS);

  // A freshly opened dialog starts from whatever the caller remembers — never
  // from a stale pick left over from the last file this session prepared.
  React.useEffect(() => {
    if (!open) return;
    setLanguage(initialLanguage);
    setScript(initialScript);
    // Deliberately [open] only: this re-seeds when the dialog (re)opens, not
    // on every keystroke in the caller's remembered values.
  }, [open]);

  const isHinglish = language === "hi-Latn" || language === "hinglish";

  // K02's cost-control invariant carries over from FIX-04: no transcription
  // credits spend without an explicit spoken-language choice. The writing
  // script is not a cost decision (it never reaches the transcribe request —
  // see this file's header doc), so it defaults to "roman" rather than
  // blocking the button; a person who cares can still pick one explicitly.
  const canGenerate = language !== undefined && file !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="prepare-media-modal">
        {item === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>Prepare your media</DialogTitle>
              <DialogDescription>
                Choose the spoken language. It decides which transcription engine your credits
                are spent on.
              </DialogDescription>
            </DialogHeader>

            {file === undefined ? null : (
              <div
                className="border-border bg-sunken mb-4 flex items-center gap-3 rounded-md border p-3"
                data-testid="prepare-media-file"
              >
                <span
                  className="bg-bg-2 text-fg-2 flex size-10 shrink-0 items-center justify-center rounded-sm"
                  aria-hidden="true"
                >
                  <FileVideo className="size-5" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-fg-0 truncate text-sm font-medium">{file.name}</span>
                  <span className="text-fg-2 text-xs">
                    {formatFileSize(file.size)} · ready to upload
                  </span>
                </span>
              </div>
            )}

            <fieldset className="mb-4 flex flex-col gap-3">
              <legend className="text-fg-0 mb-3 text-sm font-semibold">Language</legend>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex flex-1 flex-col gap-1.5">
                  <span className="text-fg-1 text-xs" id="prepare-media-language-label">
                    Spoken language
                  </span>
                  <LanguagePicker value={language} onChange={setLanguage} fullWidth />
                </div>
                <div className={cn("flex flex-1 flex-col gap-1.5", isHinglish && "hidden")}>
                  <span className="text-fg-1 text-xs" id="prepare-media-script-label">
                    Caption script
                  </span>
                  <WritingScriptPicker value={script} onChange={setScript} fullWidth />
                </div>
              </div>
            </fieldset>

            {/*
              Options. Audio enhancement and emojis were live-looking switches
              whose values were never sent anywhere (neither reaches
              `onGenerate`), so they are shown switched off and disabled, with
              a word saying so, rather than letting someone believe they turned
              something on. Their test ids stay for the e2e suite.
            */}
            <div className="border-border mb-5 flex flex-col divide-y divide-border rounded-md border">
              <OptionRow
                icon={<Sparkles aria-hidden="true" />}
                title="Translation"
                description="Translate your captions into another language."
                control={
                  <Badge tone="neutral" className="gap-1">
                    <Lock className="size-3" aria-hidden="true" />
                    Creator plan
                  </Badge>
                }
              />
              <OptionRow
                icon={<Volume2 aria-hidden="true" />}
                title="Audio enhancement"
                description="Reduce background noise before transcription. Not available yet."
                control={
                  <Switch
                    checked={audioEnhancement}
                    onCheckedChange={setAudioEnhancement}
                    disabled
                    aria-label="Audio enhancement (not available yet)"
                    data-testid="toggle-audio-enhancement"
                  />
                }
              />
              <OptionRow
                icon={<Smile aria-hidden="true" />}
                title="Emojis"
                description="Add emojis that fit what is said. Not available yet."
                control={
                  <Switch
                    checked={autoEmojis}
                    onCheckedChange={setAutoEmojis}
                    disabled
                    aria-label="Emojis (not available yet)"
                    data-testid="toggle-emojis"
                  />
                }
              />
            </div>

            <Button
              type="button"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!canGenerate}
              data-testid="prepare-media-generate"
              onClick={() => {
                if (language === undefined) return;
                onGenerate(language, isHinglish ? "roman" : (script ?? "roman"));
              }}
            >
              Upload and transcribe
            </Button>
          </>
        ) : (
          <ProcessingBody item={item} tip={tip} onOpenChange={onOpenChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One row of the options list: icon, title, one sentence, and its control on the right. */
function OptionRow({
  icon,
  title,
  description,
  control,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  control: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <div className="flex items-start gap-2.5">
        <span className="text-fg-2 mt-0.5 [&_svg]:size-4">{icon}</span>
        <div>
          <p className="text-fg-0 text-sm font-medium">{title}</p>
          <p className="text-fg-2 text-xs">{description}</p>
        </div>
      </div>
      {control}
    </div>
  );
}

/**
 * Radix requires an accessible name for every dialog (`DialogTitle`) even when
 * — as here — the visible heading lives inside {@link ProcessingScreen}
 * rather than a `DialogHeader`; a screen-reader-only title is the same fix
 * `@montaj/ui`'s own `CommandDialog` uses for the identical situation.
 */
function ProcessingBody({
  item,
  tip,
  onOpenChange,
}: {
  item: UploadItemState;
  tip: string;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const percent =
    item.progress.totalBytes > 0
      ? Math.round((item.progress.uploadedBytes / item.progress.totalBytes) * 100)
      : 0;

  const openProject = (): void => {
    if (item.projectId !== undefined) router.push(`/p/${item.projectId}`);
  };
  const openProjectButton =
    item.projectId === undefined ? null : (
      <Button
        type="button"
        variant="primary"
        data-testid="prepare-media-open-project"
        onClick={openProject}
      >
        Open project
      </Button>
    );

  let body: React.JSX.Element;

  if (item.status === "duplicate") {
    body = (
      <ProcessingScreen
        icon={<Copy className="size-7" aria-hidden="true" />}
        headline="Already in your workspace"
        subtext="This exact file has already been uploaded."
        tip={tip}
      >
        {item.duplicateOfProjectId === undefined ? null : (
          <a
            href={`/p/${item.duplicateOfProjectId}`}
            className="text-accent-300 hover:text-accent-200 text-sm underline underline-offset-4"
            data-testid="prepare-media-duplicate-open"
          >
            Open the original
          </a>
        )}
      </ProcessingScreen>
    );
  } else if (item.status === "error" || item.status === "cancelled") {
    body = (
      <ProcessingScreen
        icon={<AlertTriangle className="size-7" aria-hidden="true" />}
        headline={item.status === "error" ? "The upload failed" : "Upload cancelled"}
        subtext={item.error}
        tip={tip}
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          Close
        </Button>
      </ProcessingScreen>
    );
  } else if (item.status === "ready") {
    body = (
      <ProcessingScreen
        icon={<CheckCircle2 className="size-7" aria-hidden="true" />}
        headline="Your captions are ready"
        tip={tip}
      >
        {openProjectButton}
      </ProcessingScreen>
    );
  } else if (item.status === "transcribing") {
    body = (
      <ProcessingScreen
        icon={<Captions className="size-7" aria-hidden="true" />}
        headline="Generating your captions"
        subtext="You can close this window. Transcription keeps going on the server."
        tip={tip}
      >
        {openProjectButton}
      </ProcessingScreen>
    );
  } else if (item.status === "processing") {
    body = (
      <ProcessingScreen
        icon={<ScanSearch className="size-7" aria-hidden="true" />}
        headline="Analyzing your media"
        subtext="Checking the video and audio before captions start."
        tip={tip}
      >
        {openProjectButton}
      </ProcessingScreen>
    );
  } else {
    // hashing | creating-project | uploading | paused | completing
    body = (
      <ProcessingScreen
        icon={<UploadCloud className="size-7" aria-hidden="true" />}
        headline="Uploading your video"
        subtext="Keep this tab open until the upload finishes."
        progress={item.status === "uploading" ? percent : undefined}
        tip={tip}
      />
    );
  }

  return (
    <>
      <DialogTitle className="sr-only">Preparing {item.fileName}</DialogTitle>
      {body}
    </>
  );
}
