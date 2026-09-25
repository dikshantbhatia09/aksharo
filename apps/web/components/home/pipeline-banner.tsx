"use client";

/**
 * The studio's first card: the clips pipeline, as the premium canvas draws it.
 *
 * A plain card carrying the pitch, a link field that starts a run,
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
 *    all. So the rail is the canvas's rail — numbered, with the live stage
 *    outlined in the accent — over the five stages that exist, and the live line
 *    says "stage 2 of 5" because that is the number that is true.
 *  - **The flag.** `repurpose_flow` is targeted at one workspace. Outside that
 *    cohort every route behind this card answers 404, so the card renders
 *    nothing rather than advertising a surface that is not there.
 */
import { ArrowRight, Check, Link2 } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useFeatureFlag, useRepurposeRuns } from "@montaj/api-client";
import type { RepurposeRunView, RepurposeStageView } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
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
      className={cn("border-border bg-surface flex flex-col gap-4 rounded-md border p-5", className)}
      data-testid="repurpose-entry"
      aria-labelledby="pipeline-banner-heading"
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <p className="text-fg-2 text-xs font-medium tracking-[0.06em] uppercase">Clips pipeline</p>
          <h2 id="pipeline-banner-heading" className="text-fg-0 mt-1 mb-1 text-lg font-semibold">
            One long video, nine posts
          </h2>
          <p className="text-fg-1 m-0 max-w-[60ch] text-sm">
            Paste a YouTube link. {BRAND.name} fetches and transcribes it, then looks for the
            moments worth posting. Cutting those into captioned clips is the next step we are
            building.
          </p>
        </div>

        <form
          className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <span className="relative flex min-w-0 flex-1 items-center sm:w-64 sm:flex-none">
            <Link2
              className="text-fg-2 pointer-events-none absolute left-2.5 size-4"
              aria-hidden="true"
            />
            <input
              className="border-border bg-sunken text-fg-0 placeholder:text-fg-2 hover:border-border-hover h-9 w-full rounded-sm border pr-2.5 pl-8 text-sm"
              placeholder="Paste a YouTube link"
              aria-label="YouTube link to turn into clips"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              data-testid="pipeline-url"
            />
          </span>
          {/*
            Secondary, not primary: Home's main job is the upload card above, and a
            screen gets one filled rani button at most (DESIGN.md, accent budget).
          */}
          <Button type="submit" variant="secondary" data-testid="pipeline-start">
            Start a run
          </Button>
        </form>
      </div>

      <ol className="flex flex-wrap gap-2" data-testid="pipeline-stages" aria-label="Pipeline stages">
        {STAGE_ORDER.map((key, index) => {
          const state = stageState(run, key);
          const active = state === "running";
          const done = state === "complete";
          return (
            <li key={key}>
              <NextLink
                href={run === undefined ? "/repurpose" : `/repurpose/${run.id}`}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-sm border px-2.5 text-xs whitespace-nowrap no-underline",
                  "transition-colors duration-[160ms] ease-[var(--ease-out-soft)] hover:bg-neutral-100/7",
                  // The live stage is the rail's one "you are here", drawn the
                  // way an active tab is; done and waiting differ by weight and
                  // a check, never by colour alone.
                  active
                    ? "border-accent text-fg-0 font-medium"
                    : done
                      ? "border-border text-fg-1"
                      : "border-border text-fg-2",
                )}
                aria-current={active ? "step" : undefined}
                data-state={state}
                data-testid={`pipeline-stage-${key}`}
              >
                <span className="text-fg-2 font-mono text-2xs" aria-hidden="true">
                  {done ? <Check className="size-3" /> : String(index + 1).padStart(2, "0")}
                </span>
                {/* eslint-disable-next-line security/detect-object-injection -- `key` is one of the five STAGE_ORDER literals */}
                {STAGE_COPY[key].title}
                {done ? <span className="sr-only"> (done)</span> : null}
              </NextLink>
            </li>
          );
        })}
      </ol>

      {run === undefined ? (
        <p className="text-fg-2 m-0 text-xs">
          Nothing running right now. Paste a link above to start.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3" data-testid="pipeline-live">
          <span className="text-fg-1 text-xs">
            {run.sourceDisplay ?? "Your video"} is at stage{" "}
            {String(Math.max(1, currentIndex + 1))} of {String(STAGE_ORDER.length)}
            {run.message === "" ? "" : `, ${run.message}`}
          </span>
          <span
            className="bg-bg-2 block h-1 w-[120px] overflow-hidden rounded-full"
            aria-hidden="true"
          >
            <span
              className="bg-accent block h-full rounded-full"
              style={{ width: `${String(Math.min(100, Math.max(0, run.progress)))}%` }}
            />
          </span>
          <NextLink
            href={`/repurpose/${run.id}`}
            className="text-fg-1 hover:text-fg-0 ml-auto inline-flex min-h-8 items-center gap-1.5 text-xs font-medium no-underline"
          >
            Open the run <ArrowRight className="size-3.5" aria-hidden="true" />
          </NextLink>
        </div>
      )}
    </section>
  );
}
