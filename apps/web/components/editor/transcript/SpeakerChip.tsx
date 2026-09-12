"use client";

/**
 * The speaker avatar icon on a caption row (design/06 §3.1's "Speaker Avatar
 * 👤: Opens speaker tagging dialog"). The glyph itself is a walking-figure
 * icon, not a head-and-shoulders bust — confirmed by zooming the actual
 * Kalakar reference screenshot (2026-09-12), not just its design-doc emoji
 * placeholder.
 *
 * Renaming (`PATCH /projects/{id}/transcript/speakers`) is deferred per the
 * brief — A11 does not expose that route yet — so this only reads
 * `transcript.speakers` and shows the id when no name has ever been given.
 * `lib/edg/client.ts`'s `patchTranscriptSpeakers` is wired but marked
 * `pending: "A15-1"`, so a rename click here surfaces "not available yet"
 * instead of a silent no-op.
 */
import { PersonStanding } from "lucide-react";

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
      aria-label={`Speaker: ${label} (rename coming soon)`}
      title={`Speaker: ${label} (rename coming soon)`}
      onClick={() => onRenameRequested?.(speakerId)}
      className={cn(
        "text-fg-2 hover:text-fg-0 hover:bg-bg-2 flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors duration-[160ms]",
        className,
      )}
      style={color === undefined ? undefined : { color }}
    >
      <PersonStanding className="size-3.5" aria-hidden="true" />
    </button>
  );
}
