"use client";

/**
 * One channel automation (2026-10-02): which channel, whether it is active,
 * when it last looked and how many runs it has started, its most recent videos
 * and what became of each (with a way into each run), and what the person can
 * do - pause or resume it, change the settings its next videos run with, or
 * remove it (confirmed first: it cannot be undone from here).
 */
import { ArrowRight } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { Badge, Button, ConfirmAction } from "@montaj/ui";

import {
  AUTOMATIONS_COPY,
  STATE_REASON_FALLBACK,
  automationRefusal,
  videoStateText,
} from "./automations-copy";
import {
  usePauseWatch,
  useRemoveWatch,
  useResumeWatch,
  useUpdateWatch,
  type Watch,
} from "./use-automations";

import { useBrandKit } from "@/components/brand-kit/use-brand-kit";
import { formatRelative } from "@/components/projects/project-table";
import {
  RunSetupFields,
  runSetupRequest,
  runSetupValueOf,
  validateRunSetup,
  type RunSetupValue,
} from "@/components/repurpose/RunSetupFields";

const COPY = AUTOMATIONS_COPY.list;
/** The videos a card lists; the rest are in the runs list. */
const VIDEOS_SHOWN = 5;

function StateBadge({ watch }: { readonly watch: Watch }): React.JSX.Element {
  const tone =
    watch.state === "active" ? "accepted" : watch.state === "error" ? "rejected" : "neutral";
  return (
    <Badge tone={tone} data-testid={`watch-state-${watch.id}`}>
      {COPY.state[watch.state]}
    </Badge>
  );
}

/** "Checked 5 minutes ago · next look in 1 hour · 3 runs started". */
function checkLine(watch: Watch): string {
  const parts = [
    watch.lastCheckedAt === null
      ? COPY.notChecked
      : COPY.checked(formatRelative(watch.lastCheckedAt)),
  ];
  if (watch.state === "active" && watch.nextCheckAt !== null && watch.lastCheckedAt !== null) {
    parts.push(COPY.nextCheck(formatRelative(watch.nextCheckAt)));
  }
  parts.push(COPY.runs(watch.runsStarted));
  return parts.join(" · ");
}

function SettingsEditor({
  watch,
  onDone,
}: {
  readonly watch: Watch;
  readonly onDone: () => void;
}): React.JSX.Element {
  const update = useUpdateWatch();
  const [value, setValue] = React.useState<RunSetupValue>(() => ({
    ...runSetupValueOf(watch.setup),
    method: "ai",
    autopilot: true,
  }));
  const [showProblems, setShowProblems] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A saved brand kit offers the brand switch for the channel's runs (2026-10-02).
  const brandKit = useBrandKit();
  const hasBrandKit = brandKit.data?.exists === true;
  const problems = validateRunSetup(value);

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    setError(null);
    update.mutate(
      {
        watchId: watch.id,
        setup: runSetupRequest(value, { forChannel: true, brandKit: hasBrandKit }),
      },
      {
        onSuccess: onDone,
        onError: (refused) => {
          setError(automationRefusal(refused));
        },
      },
    );
  };

  return (
    <form
      onSubmit={save}
      noValidate
      className="flex flex-col gap-4 border-t border-border pt-4"
      data-testid={`watch-settings-${watch.id}`}
    >
      <p className="text-xs text-fg-2">{COPY.settingsNote}</p>
      <RunSetupFields
        value={value}
        onChange={setValue}
        problems={showProblems ? problems : {}}
        forChannel
        brandKit={hasBrandKit}
        idPrefix={`watch-${watch.id}`}
      />
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* Secondary: the page's one primary is "Save automation". */}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={update.isPending}
          data-testid={`watch-settings-save-${watch.id}`}
        >
          {update.isPending ? COPY.savingChanges : COPY.saveChanges}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {COPY.cancel}
        </Button>
      </div>
    </form>
  );
}

export function WatchCard({
  watch,
  canChange = true,
  editing,
  onEdit,
  onDoneEditing,
}: {
  readonly watch: Watch;
  /** False for a viewer: the card is read-only. */
  readonly canChange?: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDoneEditing: () => void;
}): React.JSX.Element {
  const pause = usePauseWatch();
  const resume = useResumeWatch();
  const remove = useRemoveWatch();
  const [error, setError] = React.useState<string | null>(null);
  const onError = (refused: Error): void => {
    setError(automationRefusal(refused));
  };
  const reason =
    watch.message ?? (watch.stateReason === null ? null : STATE_REASON_FALLBACK[watch.stateReason]);
  const readProblem =
    watch.state !== "active" || watch.lastErrorCode === null
      ? null
      : watch.lastErrorCode === "channel_not_found"
        ? COPY.notFound
        : COPY.readFailed;
  const videos = watch.videos.slice(0, VIDEOS_SHOWN);

  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 sm:p-5"
      data-testid={`watch-${watch.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_200px]">
          <p
            className="truncate text-sm font-medium text-fg-0"
            data-testid={`watch-title-${watch.id}`}
          >
            {watch.title}
          </p>
          <a
            href={watch.channelUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-fg-2 no-underline hover:underline"
          >
            {watch.handle === null ? watch.channelUrl : `@${watch.handle}`}
          </a>
        </div>
        <StateBadge watch={watch} />
      </div>

      {reason === null ? null : (
        <p className="m-0 text-xs text-fg-1" data-testid={`watch-message-${watch.id}`}>
          {reason}
        </p>
      )}
      {readProblem === null ? null : (
        <p className="m-0 text-xs text-fg-1" data-testid={`watch-read-problem-${watch.id}`}>
          {readProblem}
        </p>
      )}
      <p className="m-0 text-xs text-fg-2" data-testid={`watch-checked-${watch.id}`}>
        {checkLine(watch)}
      </p>

      {videos.length === 0 ? null : (
        <div>
          <h3 className="text-xs font-medium text-fg-1">{COPY.videosHeading}</h3>
          <ul className="mt-1 divide-y divide-border">
            {videos.map((video) => (
              <li
                key={video.videoId}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5"
                data-testid={`watch-video-${video.videoId}`}
              >
                <span className="min-w-0 flex-[1_1_180px] truncate text-xs text-fg-0">
                  {video.title}
                </span>
                <span className="text-2xs text-fg-2">{videoStateText(video)}</span>
                {video.runId === null ? null : (
                  <NextLink
                    href={`/repurpose/${video.runId}`}
                    className="ml-auto flex items-center gap-1 text-xs text-fg-0 no-underline hover:underline"
                    data-testid={`watch-video-open-${video.videoId}`}
                  >
                    {COPY.open}
                    <ArrowRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </NextLink>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected">
          {error}
        </p>
      )}

      {canChange ? (
        <div className="flex flex-wrap gap-2">
          {watch.state === "active" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pause.isPending}
              data-testid={`watch-pause-${watch.id}`}
              onClick={() => {
                setError(null);
                pause.mutate(watch.id, { onError });
              }}
            >
              {COPY.pause}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={resume.isPending}
              data-testid={`watch-resume-${watch.id}`}
              onClick={() => {
                setError(null);
                resume.mutate(watch.id, { onError });
              }}
            >
              {COPY.resume}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            data-testid={`watch-edit-${watch.id}`}
            onClick={editing ? onDoneEditing : onEdit}
          >
            {COPY.edit}
          </Button>
          <ConfirmAction
            trigger={
              <Button variant="ghost" size="sm" data-testid={`watch-remove-${watch.id}`}>
                {COPY.remove}
              </Button>
            }
            title={COPY.removeTitle(watch.title)}
            description={COPY.removeDescription}
            confirmLabel={COPY.removeConfirm}
            confirmTestId={`watch-remove-confirm-${watch.id}`}
            onConfirm={() => {
              setError(null);
              remove.mutate(watch.id, { onError });
            }}
          />
        </div>
      ) : null}

      {editing && canChange ? <SettingsEditor watch={watch} onDone={onDoneEditing} /> : null}
    </li>
  );
}
