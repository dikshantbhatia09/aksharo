"use client";

/**
 * What starting several videos at once came to (2026-10-02), line by line:
 * each link or file, whether its run started (with a way into it), was already
 * running, repeated an earlier line, or was refused - and why, in the start
 * form's own sentences (`REFUSAL_COPY.start`), never the API's words.
 */
import { ArrowRight } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { Button } from "@montaj/ui";

import type { BulkRunResult } from "@/components/repurpose/automations/use-automations";

import { REFUSAL_COPY } from "@/components/repurpose/copy";

/** One line of the outcome: a link or a file. */
export interface SeveralLine {
  readonly key: string;
  /** The link as pasted, or the file's name. */
  readonly label: string;
  readonly outcome: "started" | "already_running" | "duplicate" | "refused";
  readonly runId: string | null;
  readonly text: string;
}

const BUSY_CODES: ReadonlySet<string> = new Set(["jobs/concurrency_cap", "jobs/enqueue_cap"]);

/** A refused start's sentence, from its code. */
export function refusalText(code: string | null): string {
  const copy: Readonly<Record<string, string>> = REFUSAL_COPY.start;
  if (code === null) return copy["fallback"] ?? "";
  if (code === "common/rate_limited") return SEVERAL_COPY.hourLimit;
  const key = BUSY_CODES.has(code) ? "busy" : code;
  // eslint-disable-next-line security/detect-object-injection -- a miss falls back to the table's own sentence
  return copy[key] ?? copy["fallback"] ?? "";
}

export const SEVERAL_COPY = Object.freeze({
  started: "Started",
  alreadyRunning: "Already running",
  duplicate: "The same video as an earlier line.",
  hourLimit: "You have started many videos in the last hour. Start the rest a little later.",
  open: "Open",
  heading: (started: number, total: number): string =>
    started === total
      ? `${String(started)} of ${String(total)} started`
      : `${String(started)} of ${String(total)} started. The rest are listed with why.`,
  allRuns: "See all your runs",
});

/** The bulk route's answer as lines. */
export function linesOfBulk(results: readonly BulkRunResult[]): SeveralLine[] {
  return results.map((result) => ({
    key: `link-${String(result.index)}`,
    label: result.link,
    outcome: result.outcome,
    runId: result.runId,
    text:
      result.outcome === "started"
        ? SEVERAL_COPY.started
        : result.outcome === "already_running"
          ? SEVERAL_COPY.alreadyRunning
          : result.outcome === "duplicate"
            ? (result.message ?? SEVERAL_COPY.duplicate)
            : refusalText(result.code),
  }));
}

export function SeveralResults({
  lines,
}: {
  readonly lines: readonly SeveralLine[];
}): React.JSX.Element {
  const started = lines.filter((line) => line.outcome === "started").length;
  return (
    <section
      aria-labelledby="several-results-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-5"
      data-testid="several-results"
    >
      <h2 id="several-results-heading" className="text-base text-fg-0" role="status">
        {SEVERAL_COPY.heading(started, lines.length)}
      </h2>
      <ul className="divide-y divide-border">
        {lines.map((line) => (
          <li
            key={line.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            data-testid={`several-line-${line.key}`}
          >
            <span className="min-w-0 flex-[1_1_220px] truncate font-mono text-xs text-fg-1">
              {line.label}
            </span>
            <span
              className={line.outcome === "refused" ? "text-xs text-rejected" : "text-xs text-fg-2"}
            >
              {line.text}
            </span>
            {line.runId === null ? null : (
              <NextLink
                href={`/repurpose/${line.runId}`}
                className="ml-auto flex items-center gap-1 text-xs text-fg-0 no-underline hover:underline"
                data-testid={`several-open-${line.key}`}
              >
                {SEVERAL_COPY.open}
                <ArrowRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </NextLink>
            )}
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" asChild>
        <NextLink href="/repurpose" className="no-underline" data-testid="several-all-runs">
          {SEVERAL_COPY.allRuns}
        </NextLink>
      </Button>
    </section>
  );
}
