"use client";

/**
 * K04: the editor's left icon rail (README recon §5 — Kalakar's editor has a
 * narrow vertical rail switching between Captions / Custom Fonts / Library;
 * ours rendered the transcript column directly, with no rail at all).
 *
 * A thin, VS-Code-activity-bar-style strip of icon buttons on the far edge of
 * the transcript column, with the selected tab's panel filling the rest of
 * the column. Captions is the default tab and its content is exactly what
 * `editor-client.tsx` used to render at the top of that column — this
 * component only supplies the chrome around it; the caller still owns what
 * "Captions" renders (`children`), so relocating it here changes nothing
 * about caption-editing behaviour.
 */
import { Captions, FolderOpen, Type } from "lucide-react";
import * as React from "react";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@montaj/ui";

import type { LucideIcon } from "lucide-react";

export type EditorRailTab = "captions" | "fonts" | "library";

const TABS: readonly {
  readonly id: EditorRailTab;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "captions", label: "Captions", icon: Captions },
  { id: "fonts", label: "Custom fonts", icon: Type },
  { id: "library", label: "Library", icon: FolderOpen },
];

export interface EditorRailProps {
  readonly active: EditorRailTab;
  readonly onActiveChange: (tab: EditorRailTab) => void;
  /** The "Captions" tab's content — unchanged from before this rail existed. */
  readonly captions: React.ReactNode;
  readonly fonts: React.ReactNode;
  readonly library: React.ReactNode;
  readonly className?: string;
}

export function EditorRail({
  active,
  onActiveChange,
  captions,
  fonts,
  library,
  className,
}: EditorRailProps): React.JSX.Element {
  return (
    <div className={cn("flex h-full min-w-0", className)} data-testid="editor-rail">
      <div
        className="editor-rail-tabs flex w-[74px] shrink-0 flex-col items-center gap-1 py-1.5"
        role="tablist"
        aria-label="Editor rail"
        data-testid="editor-rail-tabs"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === active;
          return (
            <Tooltip key={tab.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={tab.label}
                  data-testid={`editor-rail-tab-${tab.id}`}
                  onClick={() => onActiveChange(tab.id)}
                  className={cn(
                    "relative flex w-[62px] flex-col items-center justify-center gap-[5px] rounded-sm px-2 pt-2 pb-[7px]",
                    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
                    // Active: fg-0 on a raised well plus a 2 px accent bar on the
                    // leading edge (DESIGN.md › Accent budget), so the state is
                    // not carried by a background shade alone.
                    isActive
                      ? "bg-bg-2 text-fg-0 before:bg-accent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full"
                      : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
                  )}
                >
                  <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
                  <span className="text-2xs leading-[1.25]">{tab.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{tab.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="min-w-0 flex-1" data-testid="editor-rail-panel">
        <div role="tabpanel" hidden={active !== "captions"} className="h-full">
          {captions}
        </div>
        <div role="tabpanel" hidden={active !== "fonts"} className="h-full">
          {fonts}
        </div>
        <div role="tabpanel" hidden={active !== "library"} className="h-full">
          {library}
        </div>
      </div>
    </div>
  );
}
