"use client";

/**
 * "Do this for every new video" (2026-10-01, OpusClip's "Auto-import videos
 * from YouTube" pitch): on a YouTube link run whose clips have started to
 * arrive, one card saying that a channel can be followed and each new upload
 * made into clips by itself, with a link to Automations.
 *
 * Only where it can help: channel automations are on for this workspace, it
 * follows no channel yet (a workspace that does already knows), and the card
 * has not been put away in this browser. Put away, it stays away.
 */
import { Radio, X } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { useFeatureFlag } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import { AUTOMATIONS_FLAG, useWatches } from "./use-automations";

const DISMISS_KEY = "aksharo.automations.pitch";

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export interface ChannelPitchProps {
  /** Where the run's video came from. */
  readonly sourceKind: string;
  /** At least one of its clips is made. */
  readonly hasReadyClips: boolean;
}

export function ChannelPitch({
  sourceKind,
  hasReadyClips,
}: ChannelPitchProps): React.JSX.Element | null {
  const enabled = useFeatureFlag(AUTOMATIONS_FLAG);
  const relevant = enabled && sourceKind === "youtube_url" && hasReadyClips;
  const watches = useWatches(relevant);
  // Storage is read once mounted, so the server's page and the first paint agree.
  const [dismissed, setDismissed] = React.useState(true);
  React.useEffect(() => {
    setDismissed(wasDismissed());
  }, []);

  if (!relevant || dismissed) return null;
  if (watches.data === undefined || watches.data.items.length > 0) return null;

  return (
    <aside
      aria-label="Follow a channel"
      className="flex items-start gap-3 rounded-sm border border-border bg-surface px-3 py-3"
      data-testid="channel-pitch"
    >
      <Radio className="mt-0.5 size-4 shrink-0 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium text-fg-0">
          Get clips from every new video, by themselves
        </p>
        <p className="m-0 mt-1 text-xs text-fg-1">
          Follow a YouTube channel and each video it posts becomes an Autopilot run like this one,
          with the settings you choose. Nobody has to paste a link.
        </p>
        <Button variant="secondary" size="sm" className="mt-2" asChild>
          <NextLink
            href="/repurpose/automations"
            className="no-underline"
            data-testid="channel-pitch-open"
          >
            Follow a channel
          </NextLink>
        </Button>
      </div>
      <button
        type="button"
        aria-label="Not now"
        title="Not now"
        className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-2 hover:text-fg-0"
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISS_KEY, "dismissed");
          } catch {
            // Storage off: hidden for this visit.
          }
          setDismissed(true);
        }}
        data-testid="channel-pitch-dismiss"
      >
        <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </aside>
  );
}
