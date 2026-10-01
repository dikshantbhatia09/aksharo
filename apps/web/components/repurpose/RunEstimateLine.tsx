"use client";

/**
 * What a run will cost, above the start button, kept up to date as the form
 * changes (2026-10-01, OpusClip's "Credit usage" beside its Get clips button).
 *
 * The numbers are the API's (`GET /repurpose/estimate`), from the plan, the
 * balance and the choices made: the minutes processed at 1 credit each, and
 * with Autopilot its finished videos at the cloud render rate. A video whose
 * length is known (a file picked here, or a link the page came back to) gets
 * "about N credits"; a link's length is not looked up - that would be one
 * more request to YouTube per keystroke - so it gets the most a run of the
 * plan's window would cost, as "up to N".
 *
 * A file longer than the plan takes in an upload is said here, before its
 * bytes are sent: the upload itself would only be refused once probed. A link
 * has no such limit (a long video is processed a part at a time).
 *
 * It never blocks the form: while the estimate loads, or if it fails, there
 * is no line, and the API checks the balance again when the run starts.
 *
 * With captions the person already has (2026-10-01) finding the clips is free:
 * the captions are matched to the audio, not transcribed. The line says so,
 * and only Autopilot's finished videos are priced.
 */
import { Coins } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { spanPhrase } from "@/components/repurpose/failure-detail";
import { formatClock } from "@/components/repurpose/moment-time";
import { useRunEstimate, type RunEstimate } from "@/components/repurpose/results/use-results";
import { givesCaptions } from "@/components/repurpose/run-captions";
import { linkLinesOf, linksToSend } from "@/components/repurpose/several-links";
import { normaliseSourceLink } from "@/components/repurpose/source-link";
import {
  filesOf,
  startAtMs,
  type KnownLength,
  type StartFormValue,
} from "@/components/repurpose/SourceStartForm";
import { useMediaDuration } from "@/components/repurpose/use-media-duration";

const NUMBER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "1 credit", "38 credits", "1,00,00,178 credits". */
export function creditsText(credits: number): string {
  const whole = Math.max(0, Math.round(credits));
  return whole === 1 ? "1 credit" : `${NUMBER.format(whole)} credits`;
}

/** The length the form knows for the video it would start, or `undefined`. */
export function knownDurationOf(
  value: StartFormValue,
  fileMs: number | undefined,
  knownLength: KnownLength | undefined,
): number | undefined {
  if (value.tab === "upload") return filesOf(value).length === 1 ? fileMs : undefined;
  if (value.tab !== "link" || knownLength === undefined) return undefined;
  const url = normaliseSourceLink(value.url);
  if (url === "" || normaliseSourceLink(knownLength.link) !== url) return undefined;
  // A start picked part-way through leaves only the rest to process.
  const start = startAtMs(value) ?? 0;
  return start < knownLength.durationMs ? knownLength.durationMs - start : undefined;
}

/** How many runs the start button would begin: one per link or file. */
export function runsOf(value: StartFormValue): number {
  if (value.tab === "links") return Math.max(1, linksToSend(linkLinesOf(value.links)).length);
  if (value.tab === "upload") return Math.max(1, filesOf(value).length);
  return 1;
}

/** The sentence, from the estimate: what is processed, what is made, what it costs. */
export function estimateText(
  estimate: RunEstimate,
  input: { readonly known: boolean; readonly runs: number },
): { readonly headline: string; readonly detail: string } {
  const each = input.runs > 1 ? "Each video: " : "";
  const finished = estimate.finishedVideos;
  const made =
    finished === null
      ? ""
      : `, then about ${String(finished.videos)} finished videos (${String(finished.clips)} clips in 4 sizes, captions burned in) for ${creditsText(finished.credits)}`;
  const minutes = spanPhrase(estimate.processMs);
  if (estimate.captionsGiven === true) {
    const then =
      finished === null
        ? "."
        : `. Autopilot's ${String(finished.videos)} finished videos (${String(finished.clips)} clips in 4 sizes, captions burned in) cost ${input.known ? "about" : "up to"} ${creditsText(finished.credits)}.`;
    return {
      headline:
        finished === null
          ? `${each}free to find clips`
          : `${each}${input.known ? "about" : "up to"} ${creditsText(estimate.totalCredits)}`,
      detail: `Finding clips is free: your captions are matched to the audio instead of transcribed${then}`,
    };
  }
  if (input.known) {
    return {
      headline: `${each}about ${creditsText(estimate.totalCredits)}`,
      detail: `Finding clips in ${minutes} of video costs ${creditsText(estimate.processCredits)}${made}.`,
    };
  }
  return {
    headline: `${each}up to ${creditsText(estimate.totalCredits)}`,
    detail: `For a video of ${minutes} or longer: finding clips costs 1 credit a minute${
      finished === null
        ? ""
        : `, and Autopilot's finished videos about ${creditsText(finished.credits)} more`
    }. A shorter video costs less.`,
  };
}

export interface RunEstimateLineProps {
  readonly value: StartFormValue;
  /** The video's length and link, when the page came from a run that learned it. */
  readonly knownLength?: KnownLength;
  /** The longest file the plan takes in an upload, when known; `undefined` for no limit. */
  readonly maxUploadMs?: number;
}

export function RunEstimateLine({
  value,
  knownLength,
  maxUploadMs,
}: RunEstimateLineProps): React.JSX.Element | null {
  const files = filesOf(value);
  const fileMs = useMediaDuration(value.tab === "upload" ? (files[0] ?? null) : null);
  const durationMs = knownDurationOf(value, fileMs, knownLength);
  const runs = runsOf(value);
  const estimate = useRunEstimate({
    ...(durationMs === undefined ? {} : { durationMs }),
    automation: value.autopilot ? "auto" : "manual",
    ...(value.method === "ai" ? { clipLength: value.clipLength } : {}),
    ...(givesCaptions(value) ? { captions: true } : {}),
    enabled: true,
  });

  const tooLong =
    value.tab === "upload" &&
    files.length === 1 &&
    fileMs !== undefined &&
    maxUploadMs !== undefined &&
    fileMs > maxUploadMs + 1000;
  if (tooLong) {
    return (
      <p
        className="m-0 flex items-start gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-fg-1"
        role="status"
        data-testid="run-estimate"
        data-state="too-long"
      >
        <Coins
          className="mt-0.5 size-4 shrink-0 text-warning"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span>
          This file runs {formatClock(fileMs)}, longer than the {spanPhrase(maxUploadMs)} your plan
          takes in an upload, so it would be refused. Upload a shorter cut, or paste its YouTube
          link: a long video is processed a part at a time.
        </span>
      </p>
    );
  }

  const data = estimate.data;
  if (data === undefined) return null;

  if (data.windowMs <= 0 && data.captionsGiven !== true) {
    return (
      <p
        className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-fg-1"
        role="status"
        data-testid="run-estimate"
        data-state="no-credits"
      >
        <Coins className="size-4 shrink-0 text-warning" strokeWidth={1.75} aria-hidden="true" />
        <span>
          You have {creditsText(data.creditsLeft)}: not enough to process a minute of video.
        </span>
        <NextLink
          href="/billing"
          className="rounded-sm text-accent underline underline-offset-4 hover:text-accent-200"
        >
          See your credits
        </NextLink>
      </p>
    );
  }

  const text = estimateText(data, { known: durationMs !== undefined, runs });
  const short = data.totalCredits * runs > data.creditsLeft;
  return (
    <div
      className="flex items-start gap-2 rounded-sm border border-border bg-surface px-3 py-2"
      aria-live="polite"
      data-testid="run-estimate"
      data-state={durationMs === undefined ? "up-to" : "about"}
    >
      <Coins className="mt-0.5 size-4 shrink-0 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 text-sm">
        <p className="m-0 text-fg-0">
          <span className="font-medium" data-testid="run-estimate-headline">
            {text.headline.charAt(0).toUpperCase() + text.headline.slice(1)}
          </span>
          <span className="text-fg-2"> · you have {creditsText(data.creditsLeft)}</span>
        </p>
        <p className="m-0 mt-0.5 text-xs text-fg-2">{text.detail}</p>
        {short ? (
          <p className="m-0 mt-0.5 text-xs text-warning" data-testid="run-estimate-short">
            That may be more than you have: the clips are found and cut first, and a finished video
            your credits cannot pay for is not made.
          </p>
        ) : null}
      </div>
    </div>
  );
}
