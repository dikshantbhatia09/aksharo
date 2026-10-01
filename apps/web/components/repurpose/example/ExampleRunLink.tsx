"use client";

/**
 * "See a finished example" (2026-10-01, OpusClip's "try a sample project"):
 * a quiet link to `/repurpose/example`, on the start form and in "What one
 * video gives you", so someone new can see what a run makes before spending a
 * credit.
 *
 * Shown only while an example is set and can be opened (`useExampleRun`): the
 * product ships with none, and then nothing here renders at all. A plain
 * text link, never a button: the start form's one primary is "Start".
 */
import { PlayCircle } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { cn } from "@montaj/ui";

import { useExampleRun } from "./use-example-run";

export const EXAMPLE_LINK_COPY = Object.freeze({
  label: "See a finished example",
  hint: "Clips, scores, every size and the images from one video, before you spend a credit.",
});

export interface ExampleRunLinkProps {
  /** Adds the one-line explanation under the link. */
  readonly withHint?: boolean;
  readonly className?: string;
}

export function ExampleRunLink({
  withHint = false,
  className,
}: ExampleRunLinkProps): React.JSX.Element | null {
  const example = useExampleRun();
  if (example.data?.available !== true) return null;
  return (
    <p className={cn("m-0 flex flex-col gap-0.5", className)} data-testid="example-run-entry">
      <NextLink
        href="/repurpose/example"
        className="inline-flex items-center gap-1.5 self-start text-sm text-fg-0"
        data-testid="example-run-link"
      >
        <PlayCircle className="size-4 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
        {EXAMPLE_LINK_COPY.label}
      </NextLink>
      {withHint ? <span className="text-xs text-fg-2">{EXAMPLE_LINK_COPY.hint}</span> : null}
    </p>
  );
}
