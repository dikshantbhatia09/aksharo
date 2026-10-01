"use client";

/**
 * Autopilot's hook titles, for the whole run (2026-10-01, OpusClip's "Auto
 * headline ... Disable it"): one line above the clips saying they are on, and
 * the switch. Off takes Autopilot's own title out of every clip (a title a
 * person added stays) and new clips get none; on puts it back. Each clip's
 * captioned videos are made again a minute later, as after any edit, which the
 * line says.
 *
 * Editors and up may switch it; everyone else reads the line.
 */
import { Type } from "lucide-react";
import * as React from "react";

import { Button } from "@montaj/ui";

import { useHookTitles } from "./use-results";

export interface HookTitlesSwitchProps {
  readonly runId: string;
  readonly enabled: boolean;
  readonly canChange: boolean;
}

export function HookTitlesSwitch({
  runId,
  enabled,
  canChange,
}: HookTitlesSwitchProps): React.JSX.Element {
  const hookTitles = useHookTitles();
  const changed = hookTitles.data?.changed;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm border border-border bg-surface px-3 py-2"
      data-testid="hook-titles"
      data-state={enabled ? "on" : "off"}
    >
      <Type className="size-4 shrink-0 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
      <p className="m-0 min-w-0 flex-[1_1_240px] text-sm text-fg-1">
        {enabled
          ? "Hook titles are on: each clip opens with a headline over its first seconds."
          : "Hook titles are off for this video's clips."}
        {hookTitles.isSuccess && changed !== undefined && changed > 0 ? (
          <span className="text-fg-2" role="status" data-testid="hook-titles-done">
            {" "}
            {String(changed)} {changed === 1 ? "video is" : "videos are"} being made again.
          </span>
        ) : null}
      </p>
      {canChange ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={hookTitles.isPending}
          onClick={() => {
            hookTitles.mutate({ runId, enabled: !enabled });
          }}
          data-testid="hook-titles-toggle"
        >
          {hookTitles.isPending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        </Button>
      ) : null}
      {hookTitles.isError ? (
        <p role="alert" className="m-0 w-full text-xs text-rejected">
          That did not work. Try again.
        </p>
      ) : null}
    </div>
  );
}
