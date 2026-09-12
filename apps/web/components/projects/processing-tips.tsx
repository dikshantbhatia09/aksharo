"use client";

/**
 * The shared pieces behind K02's full-screen processing states (scope item
 * 3, reference frames `frame_0050.png`/`frame_0055.png`/`frame_0060.png`):
 * an icon, a headline, a progress indicator and a rotating "Did you know?"
 * tip box. Used by `prepare-media-modal.tsx` (Home, while a single drop is
 * uploading) and `needs-transcription.tsx` (the editor, while the server
 * pipeline analyses media or transcribes it) so the same immersive shape
 * appears everywhere this product actually waits on a job — without either
 * screen re-deriving its own copy of the tip rotator.
 *
 * Copy is this product's own voice, not a translation of Kalakar's — the
 * wave README is explicit that parity means behavior and information
 * density, not borrowed marketing lines.
 */
import * as React from "react";

import { ProgressBar } from "@montaj/ui";

import { cn } from "@/lib/utils";

export const PROCESSING_TIPS: readonly string[] = [
  "Sabr karo, sabr ka phal meetha hota hai.",
  "Good things take time, great captions take seconds.",
  "Polishing every word for maximum engagement.",
  "Kalakar is the most accurate captioning tool for South Asian languages.",
  "Hinglish and other code-mixed speech get their own transcription lane for better accuracy.",
  "Word-level timing means you can nudge a single word without retiming the rest of the line.",
  "Switch between Roman, Native and English captions any time from the editor's script tabs.",
  "Emphasis, glow, shadows and 3D depth are one click away in the Style panel once captions land.",
  "Tip: You can customize fonts and colors once your transcript is ready.",
];

/** Cycles through `tips` every `intervalMs`; a single tip never rotates. */
export function useRotatingTip(tips: readonly string[], intervalMs = 5_000): string {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (tips.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % tips.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [tips, intervalMs]);

  return tips[index % tips.length] ?? tips[0] ?? "";
}

export function DidYouKnow({
  tip,
  className,
}: {
  tip: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "border-border bg-bg-2 flex flex-col gap-1 rounded-md border p-3 text-left",
        className,
      )}
      data-testid="processing-tip"
      role="status"
      aria-live="polite"
    >
      <p className="text-lime-500 text-2xs font-semibold tracking-wide uppercase">Did you know?</p>
      <p className="text-fg-1 text-sm">{tip}</p>
    </div>
  );
}

/**
 * A progress indicator with no honest percentage to show (probing, proxying
 * and transcription report no byte-level progress today) — a filled bar that
 * pulses rather than one that claims a number the pipeline cannot back up.
 * `role="progressbar"` with no `aria-valuenow` is the correct ARIA shape for
 * "working, duration unknown" (WAI-ARIA APG), same as a native
 * `<progress>` with no `value`.
 */
export function IndeterminateBar({
  label,
  className,
}: {
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      className={cn("bg-bg-2 h-1.5 w-full overflow-hidden rounded-full", className)}
    >
      <div className="bg-lime-500 h-full w-full animate-pulse rounded-full" />
    </div>
  );
}

export interface ProcessingScreenProps {
  readonly icon: React.ReactNode;
  readonly headline: string;
  readonly subtext?: string;
  /** 0–100 for a real, measured progress; `undefined` renders the pulsing indeterminate bar. */
  readonly progress?: number;
  readonly tip: string;
  readonly className?: string;
  readonly children?: React.ReactNode;
}

/** The shared shell: icon, headline, subtext, a progress indicator, the tip box. */
export function ProcessingScreen({
  icon,
  headline,
  subtext,
  progress,
  tip,
  className,
  children,
}: ProcessingScreenProps): React.JSX.Element {
  return (
    <div
      className={cn("flex w-full flex-col items-center gap-4 text-center", className)}
      data-testid="processing-screen"
    >
      <div
        className="border-lime-500/30 bg-lime-500/10 text-lime-500 flex size-16 items-center justify-center rounded-full border"
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-fg-0 text-lg font-semibold" data-testid="processing-headline">
          {headline}
        </h2>
        {subtext === undefined ? null : <p className="text-fg-2 max-w-sm text-sm">{subtext}</p>}
      </div>
      <div className="w-full max-w-xs">
        {progress === undefined ? (
          <IndeterminateBar label={headline} />
        ) : (
          <ProgressBar value={progress} label={headline} />
        )}
      </div>
      {children}
      <DidYouKnow tip={tip} className="w-full max-w-sm" />
    </div>
  );
}
