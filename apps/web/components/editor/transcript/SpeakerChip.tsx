"use client";

/**
 * The speaker pill at the start of a segment.
 *
 * Renaming (`PATCH /projects/{id}/transcript/speakers`) is deferred per the
 * brief — A11 does not expose that route yet — so this only reads
 * `transcript.speakers` and shows the id when no name has ever been given.
 * `lib/edg/client.ts`'s `patchTranscriptSpeakers` is wired but marked
 * `pending: "A15-1"`, so a rename click here surfaces "not available yet"
 * instead of a silent no-op.
 */
import { cn } from "@/lib/utils";

export interface SpeakerChipProps {
  readonly speakerId: string;
  readonly name?: string;
  readonly color?: string;
  readonly onRenameRequested?: (speakerId: string) => void;
  readonly className?: string;
}

export function SpeakerChip({
  speakerId,
  name,
  color,
  onRenameRequested,
  className,
}: SpeakerChipProps): React.JSX.Element {
  const label = name === undefined || name.trim() === "" ? speakerId : name;
  return (
    <button
      type="button"
      data-testid={`speaker-chip-${speakerId}`}
      title="Rename speaker (coming soon)"
      onClick={() => onRenameRequested?.(speakerId)}
      className={cn(
        "border-border bg-bg-2 text-fg-1 hover:text-fg-0 text-2xs inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium transition-colors duration-[160ms]",
        className,
      )}
      style={color === undefined ? undefined : { borderColor: color }}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "currentColor" }}
      />
      {label}
    </button>
  );
}
