"use client";

/**
 * Home (08 §Home, F-101, F-102): greeting, drop zone with the quick-pick row,
 * the upload tray, and the Recent projects grid. `/` is the URL a signed-in
 * visitor sees this at — `middleware.ts` rewrites an authenticated request
 * for "/" here invisibly, because `(site)/page.tsx` already owns "/" for the
 * signed-out marketing page and Next.js refuses two page files that resolve
 * the same path.
 *
 * Dropping two or more files at once opens the "Apply to all" batch sheet
 * (B15 brief §4) instead of uploading immediately: `BatchApplyToAllSheet`
 * quotes credits, creates the batch (`POST /batch`) and hands back
 * `{file, projectId}` pairs that `useUploadQueue().addFilesToProjects` feeds
 * into the same upload pipeline a single file uses, just without letting each
 * job create its own project. A single file dropped keeps the original path
 * unchanged.
 */
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { useCurrentUser, useProjects } from "@montaj/api-client";
import { toast } from "@montaj/ui";

import { LocalProjectsSection } from "./local-projects-section";

import type { UploadQuickPick } from "@/lib/upload/types";

import { BatchApplyToAllSheet, type BatchConfirmed } from "@/components/batch/BatchApplyToAllSheet";
import { BatchProgressView } from "@/components/batch/BatchProgressView";
import { DropZone } from "@/components/projects/drop-zone";
import { rememberedLanguage, rememberLanguage } from "@/components/projects/language-picker";
import { PrepareMediaModal } from "@/components/projects/prepare-media-modal";
import { ProjectGrid, SampleProjectButton } from "@/components/projects/project-grid";
import { defaultQuickPickLanguage, QuickPickRow } from "@/components/projects/quick-pick-row";
import { UploadTray } from "@/components/projects/upload-tray";
import {
  rememberedWritingScript,
  rememberWritingScript,
} from "@/components/projects/writing-script-picker";
import { useUploadQueue } from "@/lib/upload/use-upload-queue";

function firstName(fullName: string | null): string | undefined {
  if (fullName === null || fullName.trim() === "") return undefined;
  return fullName.trim().split(/\s+/)[0];
}

export function HomeView(): React.JSX.Element {
  const user = useCurrentUser();
  const recent = useProjects({ limit: 12 });
  const queue = useUploadQueue();
  const searchParams = useSearchParams();
  const dropZoneRef = React.useRef<HTMLDivElement>(null);
  const [pendingBatchFiles, setPendingBatchFiles] = React.useState<readonly File[] | undefined>(
    undefined,
  );
  const [activeBatchId, setActiveBatchId] = React.useState<string | undefined>(undefined);

  // K02: a single file dropped opens "Prepare Your Media" instead of uploading
  // straight away — `localId` fills in once `queue.addFiles` has registered the
  // row (see the effect below), at which point the SAME dialog switches from
  // the language/script form to narrating that row's real upload/analyze/
  // transcribe progress. `undefined` throughout means "nothing pending".
  const [pendingMedia, setPendingMedia] = React.useState<
    { readonly file: File; readonly localId: string | undefined } | undefined
  >(undefined);

  // FIX-04 precedence: an explicit pick (this session, or one this browser
  // remembers) beats the server's onboarding default, which beats empty. The
  // language therefore starts ABSENT — it is never inferred, because the tag
  // decides which lane the credits are spent in.
  const [quickPick, setQuickPick] = React.useState<UploadQuickPick>(() => ({
    aspect: "9:16",
  }));

  // The remembered pick is adopted in an effect, not in the initializer above,
  // because this page is server-rendered first: `localStorage` does not exist
  // there, and React keeps the *server's* initial state through hydration
  // rather than re-running the initializer on the client. Reading it here is
  // what makes "Home remembers what I chose last time" actually true in the
  // browser. It runs before the onboarding answer arrives (that one waits on a
  // fetch), and both fill only a still-empty language, so the precedence holds
  // whichever order they land in.
  React.useEffect(() => {
    const remembered = rememberedLanguage();
    if (remembered === undefined) return;
    setQuickPick((current) =>
      current.language === undefined ? { ...current, language: remembered } : current,
    );
  }, []);

  // Once the user's own onboarding answers load, adopt them as the starting
  // point — but only before anyone has touched the picker, so this never
  // clobbers a deliberate choice (B17: "what you make" → aspect/style,
  // "languages you speak on camera" → language + routing hints).
  const [languageTouched, setLanguageTouched] = React.useState(false);
  React.useEffect(() => {
    if (languageTouched) return;
    const onboarding = user.data?.onboarding;
    if (onboarding === undefined) return;
    setQuickPick((current) => ({
      ...current,
      // FIX-04: adoption fills the *empty* language, it never overwrites one.
      // A remembered pick loaded above is already an explicit answer, and
      // `defaultQuickPickLanguage` now returns undefined rather than Hinglish
      // when the account never answered the onboarding step either.
      ...(current.language !== undefined
        ? {}
        : (() => {
            const adopted = defaultQuickPickLanguage(onboarding.languages);
            return adopted === undefined ? {} : { language: adopted };
          })()),
      ...(onboarding.languages === undefined ? {} : { languages: onboarding.languages }),
      ...(onboarding.defaultAspect === undefined ? {} : { aspect: onboarding.defaultAspect }),
      ...(current.styleId === undefined && onboarding.defaultStyleId !== undefined
        ? { styleId: onboarding.defaultStyleId }
        : {}),
    }));
  }, [languageTouched, user.data?.onboarding]);

  // The command palette's "New project" action lands here with `?new=1`
  // (`command-palette.tsx`); focusing the drop zone is the closest a page can
  // get to "opened the picker" without a click already being on the file
  // input, which browsers refuse to trigger programmatically off a query
  // param rather than a user gesture.
  React.useEffect(() => {
    if (searchParams.get("new") === "1") dropZoneRef.current?.focus();
  }, [searchParams]);

  /**
   * FIX-04's cost-control invariant: nothing enters the upload funnel without a
   * language, because the funnel ends in a paid transcription. Returns true when
   * the drop may proceed; otherwise it says why and puts the picker on screen.
   *
   * K02: a single file no longer goes through this gate at all — "Prepare Your
   * Media" is now that gate (`Generate Transcription` stays disabled until a
   * language is chosen). The batch ("apply to all") path still calls this
   * directly, since `BatchApplyToAllSheet` is outside this WP's file
   * boundary and keeps its own pre-drop expectation of `quickPick.language`.
   */
  const requireLanguage = React.useCallback((): boolean => {
    if (quickPick.language !== undefined) return true;
    toast.info("Choose the spoken language first", {
      description: "It decides which transcription lane your credits are spent on.",
    });
    const picker = document.querySelector('[data-testid="quickpick-language"]');
    picker?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (picker instanceof HTMLElement) picker.focus();
    return false;
  }, [quickPick.language]);

  const projects = recent.data?.pages.flatMap((page) => page.items) ?? [];
  const name = firstName(user.data?.name ?? null);

  const handleBatchConfirmed = (result: BatchConfirmed): void => {
    if (!requireLanguage()) return;
    queue.addFilesToProjects(result.pairs, quickPick);
    setPendingBatchFiles(undefined);
    setActiveBatchId(result.batchId);
  };

  // K02: once `queue.addFiles` has registered `pendingMedia.file`'s row, adopt
  // its id so the modal can start narrating the row's real status. Matched by
  // name+size rather than returned from `addFiles` (which stays `void` —
  // `useUploadQueue` is outside this WP's file boundary, see REPORT.md) —
  // `Object.values` preserves insertion order for the UUID keys `addFiles`
  // generates, so the last match is the one this drop just created even if an
  // identical file is mid-upload elsewhere in the tray.
  React.useEffect(() => {
    if (pendingMedia === undefined || pendingMedia.localId !== undefined) return;
    const matches = queue.items.filter(
      (candidate) =>
        candidate.fileName === pendingMedia.file.name &&
        candidate.fileSize === pendingMedia.file.size,
    );
    const match = matches[matches.length - 1];
    if (match !== undefined) {
      setPendingMedia({ file: pendingMedia.file, localId: match.id });
    }
  }, [queue.items, pendingMedia]);

  const pendingMediaItem =
    pendingMedia?.localId === undefined
      ? undefined
      : queue.items.find((candidate) => candidate.id === pendingMedia.localId);

  return (
    <div className="flex flex-col gap-8" data-testid="home-view">
      <div>
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          {name === undefined ? "Good to see you" : `Good to see you, ${name}`}
        </h1>
      </div>

      {pendingBatchFiles === undefined ? (
        <div className="flex flex-col gap-3" ref={dropZoneRef} tabIndex={-1}>
          <DropZone
            onFiles={(files) => {
              if (files.length >= 2) {
                if (!requireLanguage()) return;
                setPendingBatchFiles(files);
                return;
              }
              const file = files[0];
              if (file === undefined) return;
              // K02: "Prepare Your Media" replaces the pre-drop language gate for
              // a single file — it opens regardless of whether `quickPick.language`
              // is already set (pre-filling it when it is), and is itself where an
              // unanswered language now blocks the upload (`Generate Transcription`
              // stays disabled).
              setPendingMedia({ file, localId: undefined });
            }}
          />
          <QuickPickRow
            value={quickPick}
            onChange={(next) => {
              setLanguageTouched(true);
              // FIX-04: an explicit pick is remembered per browser, so the next
              // visit opens on the answer this user already gave (scale note:
              // per-device, no migration, cannot leak between workspace members).
              if (next.language !== undefined && next.language !== quickPick.language) {
                rememberLanguage(next.language);
              }
              setQuickPick(next);
            }}
          />
        </div>
      ) : (
        <BatchApplyToAllSheet
          files={pendingBatchFiles}
          quickPick={quickPick}
          onCancel={() => setPendingBatchFiles(undefined)}
          onConfirmed={handleBatchConfirmed}
        />
      )}

      {activeBatchId === undefined ? null : <BatchProgressView batchId={activeBatchId} />}

      <PrepareMediaModal
        open={pendingMedia !== undefined}
        file={pendingMedia?.file}
        item={pendingMediaItem}
        initialLanguage={quickPick.language}
        initialScript={rememberedWritingScript()}
        onOpenChange={(open) => {
          if (!open) setPendingMedia(undefined);
        }}
        onGenerate={(language, script) => {
          if (pendingMedia === undefined) return;
          const next: UploadQuickPick = { ...quickPick, language };
          setLanguageTouched(true);
          rememberLanguage(language);
          rememberWritingScript(script);
          setQuickPick(next);
          queue.addFiles([pendingMedia.file], next);
        }}
      />

      <UploadTray
        items={queue.items}
        pause={queue.pause}
        resume={queue.resume}
        cancel={queue.cancel}
        dismiss={queue.dismiss}
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-fg-0 text-lg font-semibold">Recent projects</h2>
          {projects.length === 0 ? null : <SampleProjectButton variant="outline" />}
        </div>
        <ProjectGrid projects={projects} loading={recent.isPending} />
      </div>

      <LocalProjectsSection />
    </div>
  );
}
