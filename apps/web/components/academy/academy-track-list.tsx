"use client";

import { GraduationCap } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useAcademyProgress } from "@montaj/api-client";
import { Badge, Card, PageHeader, ProgressBar, Skeleton } from "@montaj/ui";

import type { AcademyTrack } from "@/lib/content/schema";

const CATEGORY_LABEL: Record<string, string> = {
  reels: "Reels",
  podcasts: "Podcasts",
  editors: "Editors",
  agency: "Agency",
};

/** `/academy`: every track, with live progress once it's loaded. */
export function AcademyTrackList({
  tracks,
}: {
  readonly tracks: readonly AcademyTrack[];
}): React.JSX.Element {
  const progress = useAcademyProgress();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <PageHeader
        title="Academy"
        description="Short tracks that each end in something you can post. Finish one and the credits land in your workspace."
      />

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="academy-track-list">
        {tracks.map((track) => {
          const trackProgress = progress.data?.tracks.find((entry) => entry.trackId === track.id);
          const completed = trackProgress?.completedStepIds.length ?? 0;
          const total = track.steps.length;
          return (
            <li key={track.id}>
              <Link
                href={`/academy/${track.id}`}
                className="block h-full rounded-md no-underline"
                data-testid={`academy-track-${track.id}`}
              >
                <Card className="hover:bg-bg-2/60 flex h-full flex-col gap-3 transition-colors duration-[160ms]">
                  <div className="flex items-start justify-between gap-2">
                    <GraduationCap
                      className="text-fg-2 size-5 shrink-0"
                      aria-hidden
                      strokeWidth={1.75}
                    />
                    <Badge tone={trackProgress?.rewardGranted ? "accepted" : "neutral"}>
                      {trackProgress?.rewardGranted
                        ? "Reward earned"
                        : `${track.creditReward} credits`}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-fg-2 text-2xs font-medium tracking-[0.08em] uppercase">
                      {CATEGORY_LABEL[track.category] ?? track.category}
                    </p>
                    <h2 className="text-fg-0 mt-1 text-base font-semibold">{track.title}</h2>
                    <p className="text-fg-1 mt-1 text-sm">{track.outcome}</p>
                  </div>
                  {progress.isPending ? (
                    <Skeleton className="h-2" />
                  ) : (
                    <div className="mt-auto flex flex-col gap-1">
                      <ProgressBar
                        value={total === 0 ? 0 : (completed / total) * 100}
                        label={`${track.title} progress`}
                      />
                      <p className="text-fg-2 text-xs">
                        {completed}/{total} steps
                      </p>
                    </div>
                  )}
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
