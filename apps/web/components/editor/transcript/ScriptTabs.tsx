"use client";

/**
 * Roman / Native / EN — switches the displayed text while keeping every
 * word's timing (08 §4). Purely a display-mode selector: it changes which of
 * `Word.scripts` each `WordChip` reads, never an op.
 */
import { cn } from "@/lib/utils";

export type DisplayScript = "roman" | "native" | "en";

const TABS: readonly { readonly id: DisplayScript; readonly label: string }[] = [
  { id: "roman", label: "Roman" },
  { id: "native", label: "Native" },
  { id: "en", label: "EN" },
];

export interface ScriptTabsProps {
  readonly value: DisplayScript;
  readonly onChange: (script: DisplayScript) => void;
  /** Scripts the transcript actually carries (`EdgHot.transcript.scripts`); others are disabled. */
  readonly available?: readonly string[];
  readonly className?: string;
}

export function ScriptTabs({
  value,
  onChange,
  available,
  className,
}: ScriptTabsProps): React.JSX.Element {
  return (
    <div className={cn("flex gap-1", className)} role="tablist" aria-label="Script">
      {TABS.map((tab) => {
        const disabled = available !== undefined && !available.includes(tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            disabled={disabled}
            data-testid={`script-tab-${tab.id}`}
            onClick={() => {
              onChange(tab.id);
            }}
            className={cn(
              "rounded-md px-2 py-1 text-xs",
              value === tab.id ? "bg-white text-black" : "bg-white/10 text-white/80",
              disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
