"use client";

/**
 * "Post one a day" for a whole run (2026-09-29): the chosen clips go out one
 * per day at the chosen time (7 pm India time unless changed), on each chosen
 * account, skipping days that account already has something posted. Agencies
 * advise posting at least three times a week and ideally daily; this makes a
 * run's clips into that rhythm with one confirmation.
 *
 * Clips start ticked (choosing clips is not acting for anyone); accounts do
 * not (D60) - nothing is scheduled without the person picking where.
 *
 * While the workspace needs approval before posting (2026-10-03), a clip that
 * is not approved is listed, unticked and not tickable, with the reason: the
 * API would leave it out anyway (`skipped`).
 */
import Link from "next/link";
import * as React from "react";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  toast,
} from "@montaj/ui";

import { PUBLISH_COPY, UNAVAILABLE_COPY, describePublishError, formatWhen } from "./publish-copy";
import {
  newIdempotencyKey,
  useDailyPosts,
  usePublishingChannels,
  usePublishingStatus,
} from "./use-publishing";

import type { RunReview } from "@/components/repurpose/review/use-review";

import { REVIEW_COPY } from "@/components/repurpose/review/review-copy";
import { isRemovedCandidate } from "@/components/repurpose/steering";
import { INLINE_LINK_CLASS } from "@/components/settings/section";

const INDIA = "Asia/Kolkata";

export interface RunPublishingProps {
  readonly runId: string;
  readonly clips: readonly RepurposeClipItem[];
  readonly candidates: readonly RepurposeCandidateItem[];
  /** The run's review (2026-10-03), when loaded: which clips may be posted. */
  readonly review?: RunReview;
}

interface ReadyClip {
  readonly id: string;
  readonly title: string;
}

/** A run's clips that can be posted, with the names their moments carry. Removed ones are left out. */
export function readyClipsOf(
  clips: readonly RepurposeClipItem[],
  candidates: readonly RepurposeCandidateItem[],
): ReadyClip[] {
  return clips.flatMap((clip) => {
    if (clip.state !== "ready") return [];
    const candidate = candidates.find((entry) => entry.id === clip.candidateId);
    if (candidate !== undefined && isRemovedCandidate(candidate)) return [];
    return [
      { id: clip.id, title: candidate?.title ?? candidate?.headline ?? clip.title ?? "Clip" },
    ];
  });
}

/** Clips that cannot be posted for want of approval, while the workspace asks for it. */
export function unapprovedClips(review: RunReview | undefined): ReadonlySet<string> {
  if (review === undefined || !review.needsApproval) return new Set();
  return new Set(
    review.clips.filter((clip) => clip.state !== "approved").map((clip) => clip.clipId),
  );
}

function DailyForm({
  runId,
  clips,
  unapproved,
  onDone,
  onCancel,
}: {
  readonly runId: string;
  readonly clips: readonly ReadyClip[];
  readonly unapproved: ReadonlySet<string>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const channels = usePublishingChannels(true);
  const daily = useDailyPosts();
  const key = React.useRef(newIdempotencyKey());
  const [chosenClips, setChosenClips] = React.useState<ReadonlySet<string>>(
    () => new Set(clips.filter((clip) => !unapproved.has(clip.id)).map((clip) => clip.id)),
  );
  const [chosenChannels, setChosenChannels] = React.useState<ReadonlySet<string>>(new Set());
  const [time, setTime] = React.useState("19:00");

  if (channels.isLoading) {
    return (
      <p role="status" className="m-0 text-sm text-fg-2">
        {PUBLISH_COPY.loading}
      </p>
    );
  }
  const status = channels.data?.status;
  if (channels.isError || status === undefined || !status.available) {
    return (
      <p className="m-0 text-sm text-fg-1" data-testid="daily-unavailable">
        {channels.isError
          ? describePublishError(channels.error)
          : UNAVAILABLE_COPY[status?.reason ?? "not_configured"]}{" "}
        <Link href="/settings/publishing" className={INLINE_LINK_CLASS}>
          {PUBLISH_COPY.setUp}
        </Link>
      </p>
    );
  }
  const usable = (channels.data?.channels ?? []).filter(
    (channel) => channel.id !== null && channel.supported && channel.note === null,
  );
  const blocked =
    chosenClips.size === 0 || chosenChannels.size === 0 || !/^\d{2}:\d{2}$/.test(time);

  const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const submit = (): void => {
    daily.mutate(
      {
        runId,
        idempotencyKey: key.current,
        body: {
          // In the order the page lists them: that is the order they go out.
          clipIds: clips.filter((clip) => chosenClips.has(clip.id)).map((clip) => clip.id),
          channelIds: usable
            .filter((channel) => channel.id !== null && chosenChannels.has(channel.id))
            .map((channel) => channel.id as string),
          time,
          timezone: INDIA,
        },
      },
      {
        onSuccess: (result) => {
          key.current = newIdempotencyKey();
          const first = result.posts[0]?.scheduledAt ?? null;
          const skipped = result.skipped.length;
          toast.success(
            `Scheduled ${String(result.posts.length)} ${result.posts.length === 1 ? "post" : "posts"}` +
              (first === null ? "." : `, from ${formatWhen(first, INDIA)}.`) +
              (skipped === 0
                ? ""
                : ` ${String(skipped)} left out: they could not go to those accounts.`),
          );
          onDone();
        },
      },
    );
  };

  return (
    <>
      <div className="flex flex-col gap-5">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-fg-1">
            {PUBLISH_COPY.dailyAccounts}
          </legend>
          <ul className="m-0 list-none p-0">
            {usable.map((channel) => {
              const id = `daily-channel-${channel.id ?? ""}`;
              return (
                <li key={channel.id} className="flex items-center gap-3 py-1">
                  <Checkbox
                    id={id}
                    checked={channel.id !== null && chosenChannels.has(channel.id)}
                    onCheckedChange={(value) => {
                      if (channel.id !== null) {
                        setChosenChannels(toggle(chosenChannels, channel.id, value === true));
                      }
                    }}
                  />
                  <label htmlFor={id} className="text-sm text-fg-0">
                    {channel.platform}, {channel.name}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-fg-1">{PUBLISH_COPY.dailyClips}</legend>
          <ul className="m-0 list-none p-0">
            {clips.map((clip, index) => {
              const id = `daily-clip-${clip.id}`;
              const blocked = unapproved.has(clip.id);
              return (
                <li key={clip.id} className="flex items-center gap-3 py-1">
                  <Checkbox
                    id={id}
                    checked={chosenClips.has(clip.id)}
                    disabled={blocked}
                    onCheckedChange={(value) => {
                      setChosenClips(toggle(chosenClips, clip.id, value === true));
                    }}
                    {...(blocked ? { "aria-describedby": `${id}-note` } : {})}
                  />
                  <label htmlFor={id} className="min-w-0 truncate text-sm text-fg-0">
                    <span className="font-mono text-2xs text-fg-2">{String(index + 1)}.</span>{" "}
                    {clip.title}
                    {blocked ? (
                      <span
                        id={`${id}-note`}
                        className="block text-xs text-fg-2"
                        data-testid={`daily-clip-unapproved-${clip.id}`}
                      >
                        {REVIEW_COPY.needsApproval}
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <Field label={PUBLISH_COPY.dailyTime} htmlFor="daily-time">
          <Input
            id="daily-time"
            type="time"
            className="w-36"
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
            }}
          />
        </Field>
        {daily.isError ? (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="daily-error">
            {describePublishError(daily.error)}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {PUBLISH_COPY.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={blocked || daily.isPending}
          onClick={submit}
          data-testid="daily-confirm"
        >
          {daily.isPending ? PUBLISH_COPY.sending : PUBLISH_COPY.dailyConfirm(chosenClips.size)}
        </Button>
      </DialogFooter>
    </>
  );
}

export function RunPublishing({
  runId,
  clips,
  candidates,
  review,
}: RunPublishingProps): React.JSX.Element | null {
  const { status } = usePublishingStatus();
  const [open, setOpen] = React.useState(false);
  const ready = readyClipsOf(clips, candidates);
  if (!status.enabled || ready.length === 0) return null;
  const close = (): void => {
    setOpen(false);
  };
  return (
    <div data-testid="run-publishing">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="post-one-a-day"
      >
        {PUBLISH_COPY.dailyButton}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto" data-testid="daily-dialog">
          <DialogHeader>
            <DialogTitle>{PUBLISH_COPY.dailyTitle}</DialogTitle>
            <DialogDescription>{PUBLISH_COPY.dailyDescription}</DialogDescription>
          </DialogHeader>
          {open ? (
            <DailyForm
              runId={runId}
              clips={ready}
              unapproved={unapprovedClips(review)}
              onDone={close}
              onCancel={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
