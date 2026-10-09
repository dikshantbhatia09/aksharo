"use client";

/**
 * Pillar 2 §06: Topic & Prompt-Based Co-Pilot (`copilot-bar.tsx`).
 *
 * Upgrades topic steering into an interactive AI Co-Pilot bar supporting:
 * 1. Natural language search prompts (e.g., "Find moments explaining customer acquisition cost").
 * 2. One-click suggestion chips ("Actionable Tips", "Controversial Takes",
 *    "Funny Moments", "Key Metrics & Numbers").
 * 3. Conversational prompt examples for instant discovery steering.
 */
import { Sparkles, X } from "lucide-react";
import * as React from "react";

import { Input, cn } from "@montaj/ui";

import { TOPIC_MAX_LENGTH } from "@/components/repurpose/steering";

export interface CopilotSuggestionChip {
  readonly key: string;
  readonly label: string;
  readonly prompt: string;
  readonly description: string;
}

export const COPILOT_SUGGESTION_CHIPS: readonly CopilotSuggestionChip[] = [
  {
    key: "actionable-tips",
    label: "Actionable Tips",
    prompt: "Actionable Tips",
    description: "Step-by-step frameworks, tactics, and practical advice",
  },
  {
    key: "controversial-takes",
    label: "Controversial Takes",
    prompt: "Controversial Takes",
    description: "Bold opinions, debates, and contrarian perspectives",
  },
  {
    key: "funny-moments",
    label: "Funny Moments",
    prompt: "Funny Moments",
    description: "Punchlines, laughter, banter, and light-hearted stories",
  },
  {
    key: "key-metrics-numbers",
    label: "Key Metrics & Numbers",
    prompt: "Key Metrics & Numbers",
    description: "Revenue figures, benchmarks, growth rates, and hard data",
  },
] as const;

export const COPILOT_PROMPT_EXAMPLES: readonly string[] = [
  "Find moments explaining customer acquisition cost",
  "Extract every moment where the guest talks about seed fundraising",
  "Show me funny moments or bloopers",
] as const;

export interface CopilotBarProps {
  readonly value: string;
  readonly onChange: (nextTopic: string) => void;
  /**
   * Whether to render the standalone Co-Pilot text input inside the bar.
   * Defaults to `true`. Set to `false` when attached beneath an existing
   * labelled `<Field>` input (such as in `RunSetupFields`) so both stay synced.
   */
  readonly showInput?: boolean;
  readonly placeholder?: string;
  readonly error?: string;
  readonly className?: string;
}

export function isChipActive(currentValue: string, chipPrompt: string): boolean {
  return currentValue.trim().toLowerCase() === chipPrompt.trim().toLowerCase();
}

export function CopilotBar({
  value,
  onChange,
  showInput = true,
  placeholder = 'Ask Co-Pilot: e.g. "Find moments explaining customer acquisition cost"',
  error,
  className,
}: CopilotBarProps): React.ReactElement {
  const trimmed = value.trim();
  const hasActivePrompt = trimmed.length > 0;

  const handleChipClick = (chip: CopilotSuggestionChip): void => {
    if (isChipActive(value, chip.prompt)) {
      onChange("");
    } else {
      onChange(chip.prompt);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-sm border border-border bg-bg-1 p-3",
        className,
      )}
      data-testid="copilot-bar"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-fg-0">
          <Sparkles className="size-3.5 shrink-0 text-accent-300" aria-hidden="true" />
          <span>AI Topic Co-Pilot</span>
          {hasActivePrompt && (
            <span
              data-testid="copilot-active-badge"
              className="rounded-xs bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400"
            >
              Strict Topic Match Active
            </span>
          )}
        </div>

        {hasActivePrompt && (
          <button
            type="button"
            data-testid="copilot-bar-clear"
            onClick={() => {
              onChange("");
            }}
            className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-xs text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-0"
            aria-label="Clear Co-Pilot prompt"
          >
            <X className="size-3" aria-hidden="true" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {showInput && (
        <div className="flex flex-col gap-1">
          <Input
            value={value}
            maxLength={TOPIC_MAX_LENGTH}
            placeholder={placeholder}
            data-testid="copilot-bar-input"
            aria-label="AI Topic Co-Pilot prompt"
            aria-invalid={error !== undefined}
            className="bg-sunken text-sm"
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          {error !== undefined && (
            <p
              role="alert"
              data-testid="copilot-bar-error"
              className="text-xs text-rejected"
            >
              {error}
            </p>
          )}
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Co-Pilot suggestion chips"
      >
        {COPILOT_SUGGESTION_CHIPS.map((chip) => {
          const selected = isChipActive(value, chip.prompt);
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={selected}
              title={chip.description}
              data-testid={`copilot-chip-${chip.key}`}
              onClick={() => {
                handleChipClick(chip);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors",
                selected
                  ? "border-accent bg-bg-2 text-fg-0 ring-1 ring-accent"
                  : "border-border bg-surface text-fg-1 hover:border-neutral-600 hover:text-fg-0",
              )}
            >
              <span>{chip.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-2">
        <span className="font-medium text-fg-1">Try asking:</span>
        {COPILOT_PROMPT_EXAMPLES.map((example, index) => {
          const activeExample = isChipActive(value, example);
          return (
            <button
              key={example}
              type="button"
              data-testid={`copilot-example-${index}`}
              aria-pressed={activeExample}
              onClick={() => {
                onChange(activeExample ? "" : example);
              }}
              className={cn(
                "rounded-xs border px-2 py-0.5 text-left text-2xs transition-colors",
                activeExample
                  ? "border-accent bg-bg-2 text-fg-0"
                  : "border-border/70 bg-sunken/60 text-fg-2 hover:border-neutral-600 hover:text-fg-1",
              )}
            >
              &ldquo;{example}&rdquo;
            </button>
          );
        })}
      </div>
    </div>
  );
}
