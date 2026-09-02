"use client";

/**
 * Home (08 §Home, F-101, F-102): greeting, drop zone with the quick-pick row,
 * the upload tray, and the Recent projects grid. `/` is the URL a signed-in
 * visitor sees this at — `middleware.ts` rewrites an authenticated request
 * for "/" here invisibly, because `(site)/page.tsx` already owns "/" for the
 * signed-out marketing page and Next.js refuses two page files that resolve
 * the same path.
 */
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { useCurrentUser, useProjects } from "@montaj/api-client";

import type { UploadQuickPick } from "@/lib/upload/types";

import { DropZone } from "@/components/projects/drop-zone";
import { ProjectGrid, SampleProjectButton } from "@/components/projects/project-grid";
import { defaultQuickPickLanguage, QuickPickRow } from "@/components/projects/quick-pick-row";
import { UploadTray } from "@/components/projects/upload-tray";
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

  const [quickPick, setQuickPick] = React.useState<UploadQuickPick>(() => ({
    language: "hi-Latn",
    aspect: "9:16",
  }));

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
      language: defaultQuickPickLanguage(onboarding.languages),
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

  const projects = recent.data?.pages.flatMap((page) => page.items) ?? [];
  const name = firstName(user.data?.name ?? null);

  return (
    <div className="flex flex-col gap-8" data-testid="home-view">
      <div>
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          {name === undefined ? "Good to see you" : `Good to see you, ${name}`}
        </h1>
      </div>

      <div className="flex flex-col gap-3" ref={dropZoneRef} tabIndex={-1}>
        <DropZone
          onFiles={(files) => {
            queue.addFiles(files, quickPick);
          }}
        />
        <QuickPickRow
          value={quickPick}
          onChange={(next) => {
            setLanguageTouched(true);
            setQuickPick(next);
          }}
        />
      </div>

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
    </div>
  );
}
