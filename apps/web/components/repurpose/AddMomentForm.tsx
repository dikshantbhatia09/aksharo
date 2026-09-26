"use client";

/**
 * "Add a moment by time" — the manual path through the clips pipeline.
 *
 * "I know the timestamps" was offered on the start form with nowhere to type
 * one, and a run whose discovery found nothing left the person with no way
 * forward at all (clips hardening, 2026-09-26). This is both ways in: a start
 * and an end, checked here against the contract's bounds (3 s to 3 min, inside
 * the video) and posted as a candidate the person can cut like any other.
 */
import * as React from "react";

import { useCreateRepurposeCandidate } from "@montaj/api-client";
import { Button, Field, Input } from "@montaj/ui";

import {
  formatClock,
  validateMoment,
  type MomentProblems,
} from "@/components/repurpose/moment-time";
import { describeRefusal } from "@/components/repurpose/refusal";

export interface AddMomentFormProps {
  readonly runId: string;
  /** The source video's length, when known, for the upper bound. */
  readonly durationMs?: number | null;
  /**
   * Whether moments can be added yet (the transcript exists). When not, the
   * form is shown but disabled, with `unavailableNote` saying when it will be.
   */
  readonly available: boolean;
  readonly unavailableNote?: string;
  /** Controlled open state; the form is always open when this is omitted. */
  readonly open?: boolean;
  /**
   * `true` from the toggle, and again whenever the open form is used (focused
   * or submitted): a form the page opened on its own — because the list was
   * empty — would otherwise fold away under the person when their first moment
   * lands, or when discovery does while they are typing.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

export function AddMomentForm({
  runId,
  durationMs,
  available,
  unavailableNote = "You can add moments as soon as the transcript is ready.",
  open,
  onOpenChange,
}: AddMomentFormProps): React.JSX.Element {
  const create = useCreateRepurposeCandidate();
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [problems, setProblems] = React.useState<MomentProblems>({});
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<string | null>(null);

  if (open === false) {
    return (
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenChange?.(true)}
          data-testid="add-moment-toggle"
        >
          Add a moment by time
        </Button>
      </div>
    );
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    onOpenChange?.(true);
    setRefusal(null);
    setAdded(null);
    const checked = validateMoment(start, end, durationMs);
    setProblems(checked.problems);
    if (checked.range === undefined) return;
    const { startMs, endMs } = checked.range;
    create.mutate(
      { runId, body: { startMs, endMs } },
      {
        onSuccess: () => {
          setStart("");
          setEnd("");
          setAdded(`Added the moment from ${formatClock(startMs)} to ${formatClock(endMs)}.`);
        },
        onError: (error) => {
          setRefusal(describeRefusal(error, "moment").text);
        },
      },
    );
  };

  const lengthMs =
    durationMs !== null && durationMs !== undefined && durationMs > 0 ? durationMs : null;

  return (
    <form
      onSubmit={submit}
      onFocus={() => onOpenChange?.(true)}
      noValidate
      aria-labelledby={`add-moment-heading-${runId}`}
      className="flex flex-col gap-3 rounded-md border border-border bg-bg-0 p-4"
      data-testid="add-moment-form"
    >
      <div>
        <h3 id={`add-moment-heading-${runId}`} className="m-0 text-sm font-semibold text-fg-0">
          Add a moment by time
        </h3>
        <p className="mt-1 text-xs text-fg-2">
          {available
            ? `Between 3 seconds and 3 minutes long, as m:ss.${
                lengthMs === null ? "" : ` The video is ${formatClock(lengthMs)} long.`
              }`
            : unavailableNote}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Field
          label="Start"
          htmlFor={`add-moment-start-${runId}`}
          className="w-28"
          {...(problems.start === undefined ? {} : { error: problems.start })}
        >
          {/* No `inputMode="numeric"`: a phone's number pad has no ":" key,
              and m:ss is the only format there is, so on a phone no valid
              time could be typed at all. The default keyboard has it. */}
          <Input
            id={`add-moment-start-${runId}`}
            placeholder="0:00"
            className="bg-sunken font-mono"
            value={start}
            disabled={!available}
            aria-invalid={problems.start !== undefined}
            aria-describedby={
              problems.start === undefined ? undefined : `add-moment-start-${runId}-error`
            }
            data-testid="add-moment-start"
            onChange={(event) => {
              setStart(event.target.value);
            }}
          />
        </Field>
        <Field
          label="End"
          htmlFor={`add-moment-end-${runId}`}
          className="w-28"
          {...(problems.end === undefined ? {} : { error: problems.end })}
        >
          <Input
            id={`add-moment-end-${runId}`}
            placeholder="0:30"
            className="bg-sunken font-mono"
            value={end}
            disabled={!available}
            aria-invalid={problems.end !== undefined}
            aria-describedby={
              problems.end === undefined ? undefined : `add-moment-end-${runId}-error`
            }
            data-testid="add-moment-end"
            onChange={(event) => {
              setEnd(event.target.value);
            }}
          />
        </Field>
        {/* Secondary, not primary: the page's one primary belongs to the run. */}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="mt-6"
          disabled={!available || create.isPending}
          data-testid="add-moment-submit"
        >
          {create.isPending ? "Adding…" : "Add moment"}
        </Button>
      </div>

      {refusal === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected" data-testid="add-moment-error">
          {refusal}
        </p>
      )}
      {added === null ? null : (
        <p role="status" className="m-0 text-sm text-fg-1" data-testid="add-moment-done">
          {added}
        </p>
      )}
    </form>
  );
}
