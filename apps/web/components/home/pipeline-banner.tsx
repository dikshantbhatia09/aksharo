"use client";

/**
 * The studio's first card: the clips pipeline, as the premium canvas draws it.
 *
 * An accent-ringed surface carrying the pitch, a link field that starts a run,
 * the numbered stage rail, and — when a run is actually moving — one line
 * saying which run, how far in, and a way into it.
 *
 * Two places where the canvas and the product do not line up, and what this
 * does about each:
 *
 *  - **Ten stages versus five.** The canvas draws ten pills (Upload, Analyse,
 *    Select clips, Reframe, Captions, Versions, Review, Schedule, Publish,
 *    Measure). The pipeline actually has five, and they are a server contract
 *    (`RepurposeStageView`): getting_video, finding_clips, styles_formats,
 *    review, publish. Drawing ten would mean five pills that no run can ever
 *    be "at", two of which (Schedule, Measure) have no endpoint behind them at
 *    all. So the rail is the canvas's rail — numbered, dotted, accent-tinted
 *    for the live one — over the five stages that exist, and the live line
 *    says "stage 2 of 5" because that is the number that is true.
 *  - **The flag.** `repurpose_flow` is targeted at one workspace. Outside that
 *    cohort every route behind this card answers 404, so the card renders
 *    nothing rather than advertising a surface that is not there.
 */
import { ArrowRight, Link2 } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useFeatureFlag, useRepurposeRuns } from "@montaj/api-client";
import type { RepurposeRunView, RepurposeStageView } from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";


import { STAGE_COPY, type StageKey } from "@/components/repurpose/copy";

/** The flag that gates the entire guided surface (REP-006). */
export const REPURPOSE_FLOW_FLAG = "repurpose_flow";

/** The rail's fixed order, matching the API's own stage sequence. */
const STAGE_ORDER: readonly StageKey[] = [
  "getting_video",
  "finding_clips",
  "styles_formats",
  "review",
  "publish",
];

/** A run that is neither finished nor abandoned — the one worth reporting. */
function liveRun(runs: readonly RepurposeRunView[]): RepurposeRunView | undefined {
  return runs.find((run) => run.stages.some((stage) => stage.state === "running"));
}

function stageState(
  run: RepurposeRunView | undefined,
  key: StageKey,
): RepurposeStageView["state"] | "idle" {
  if (run === undefined) return "idle";
  return run.stages.find((stage) => stage.stage === key)?.state ?? "waiting";
}

export function PipelineBanner({ className }: { className?: string }): React.JSX.Element | null {
  const enabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const runs = useRepurposeRuns(enabled);
  const router = useRouter();
  const [url, setUrl] = React.useState("");

  if (!enabled) return null;

  const run = liveRun(runs.data?.items ?? []);
  const currentIndex = run === undefined ? -1 : STAGE_ORDER.indexOf(run.currentStage as StageKey);

  const start = (): void => {
    const trimmed = url.trim();
    // The new-run screen owns the rights attestation, the language and the
    // style, and none of them can be answered from a one-line field. This
    // hands the link over rather than posting a run the user has not set up.
    router.push(trimmed === "" ? "/repurpose/new" : `/repurpose/new?url=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section
      className={cn(
        "bg-surface flex flex-col gap-[13px] rounded-lg px-5 py-[18px]",
        "shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
        className,
      )}
      data-testid="repurpose-entry"
      aria-labelledby="pipeline-banner-heading"
    >
      <div className="flex flex-wrap items-end gap-3.5">
        <div className="min-w-[260px] flex-1">
          <span className="text-accent text-[10px] tracking-[0.12em] uppercase">
            Clips pipeline
          </span>
          <h2
            id="pipeline-banner-heading"
            className="font-display mt-1.5 mb-[5px] text-2xl tracking-[-0.02em]"
          >
            One long video, nine posts
          </h2>
          <p className="text-neutral-400 m-0 max-w-[56ch] text-[13px]">
            Paste a link. Aksharo reads the transcript, scores where attention sits, cuts the
            moments, reframes them, burns in captions in the language you pick, builds a version
            per platform, then posts on your schedule.
          </p>
        </div>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <span className="relative flex min-w-[210px] items-center">
            <Link2
              className="text-neutral-500 pointer-events-none absolute left-2.5 size-[13px]"
              aria-hidden="true"
            />
            <input
              className="border-border bg-bg-0 text-fg-0 placeholder:text-neutral-500 hover:border-neutral-500 focus-visible:border-accent h-9 w-full rounded-sm border pl-[30px] pr-2.5 text-sm"
              placeholder="Paste a YouTube link"
              aria-label="YouTube link to repurpose"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              data-testid="pipeline-url"
            />
          </span>
          <Button type="submit" variant="primary" className="h-9" data-testid="pipeline-start">
            Start a run
          </Button>
        </form>
      </div>

      <ol className="flex flex-wrap gap-1.5" data-testid="pipeline-stages">
        {STAGE_ORDER.map((key, index) => {
          const state = stageState(run, key);
          const active = state === "running";
          const done = state === "complete";
          return (
            <li key={key}>
              <NextLink
                href={run === undefined ? "/repurpose" : `/repurpose/${run.id}`}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-sm border px-2.5 py-[5px] text-[11px] whitespace-nowrap no-underline",
                  "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
                  active
                    ? "border-accent bg-accent/12 text-accent-200"
                    : done
                      ? "border-border text-neutral-300"
                      : "border-border text-neutral-500",
                )}
                aria-current={active ? "step" : undefined}
                data-state={state}
                data-testid={`pipeline-stage-${key}`}
              >
                <span
                  className={cn(
                    "font-mono text-[9px]",
                    done || active ? "text-accent-300" : "text-neutral-500",
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                {/* eslint-disable-next-line security/detect-object-injection -- `key` is one of the five STAGE_ORDER literals */}
                {STAGE_COPY[key].title}
              </NextLink>
            </li>
          );
        })}
      </ol>

      {run === undefined ? (
        <p className="text-neutral-500 m-0 flex items-center gap-2 pt-0.5 text-xs">
          Nothing running right now. A link above starts the first stage.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 pt-0.5" data-testid="pipeline-live">
          <span className="text-neutral-300 flex items-center gap-2 text-xs">
            <span className="bg-accent size-[5px] rounded-full" aria-hidden="true" />
            {run.sourceDisplay ?? "Your video"} is at stage{" "}
            {String(Math.max(1, currentIndex + 1))} of {String(STAGE_ORDER.length)}
            {run.message === "" ? "" : `, ${run.message}`}
          </span>
          <span
            className="bg-neutral-800 block h-0.5 w-[120px] overflow-hidden rounded-full"
            aria-hidden="true"
          >
            <span
              className="bg-accent block h-full rounded-full"
              style={{ width: `${String(Math.min(100, Math.max(0, run.progress)))}%` }}
            />
          </span>
          <NextLink
            href={`/repurpose/${run.id}`}
            className="text-accent hover:text-accent-300 ml-auto flex items-center gap-1.5 text-xs"
          >
            Open the pipeline <ArrowRight className="size-3" aria-hidden="true" />
          </NextLink>
        </div>
      )}
    </section>
  );
}
