"use client";

/**
 * The captions column's own header (design/06-SCREEN-CAPTION-LIST-PANEL.md
 * §1): a "Captions" title, a search affordance, and a "Caption Tools ⌄"
 * trigger — distinct from the Timeline's own Search/Caption Tools pair
 * (`Timeline.tsx`, K06), which stays exactly as it is. `onSearchClick` opens
 * the editor's existing `FindReplaceDialog` rather than a new filter, and the
 * `children` this renders under the "Caption Tools" trigger is the existing
 * `BulkActionsBar` — reusing both rather than forking them is the point: this
 * component only supplies the header chrome the reference design puts around
 * them.
 */
import { ChevronDown, Search, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface CaptionsPanelHeaderProps {
  readonly onSearchClick: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export function CaptionsPanelHeader({
  onSearchClick,
  children,
  className,
}: CaptionsPanelHeaderProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={cn("editor-captions-header flex h-14 shrink-0 items-center gap-2.5", className)}
      data-testid="captions-panel-header"
    >
      <h2 className="text-fg-0 mr-auto text-[21px] font-semibold tracking-[-0.02em]">Captions</h2>

      <button
        type="button"
        onClick={onSearchClick}
        aria-label="Find and replace"
        title="Find and replace"
        data-testid="captions-panel-search"
        className="editor-pill text-fg-1 flex size-[31px] shrink-0 items-center justify-center rounded-full border transition-colors duration-[160ms]"
      >
        <Search className="size-3.5" aria-hidden="true" />
      </button>

      <div className="relative" ref={ref}>
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={open}
          data-testid="captions-panel-tools-trigger"
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="editor-pill text-fg-0 flex h-[31px] items-center gap-2 rounded-full border px-3 text-[13px] transition-colors duration-[160ms]"
        >
          <Settings className="size-[15px]" aria-hidden="true" /> Caption Tools
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
        <div
          hidden={!open}
          aria-label="Caption Tools"
          data-testid="captions-panel-tools-menu"
          className="editor-tools-popover border-border bg-bg-1 absolute top-full right-0 z-40 mt-2 flex max-h-[70vh] w-max max-w-[calc(100vw-120px)] flex-col gap-3 overflow-auto rounded-sm border p-3 shadow-xl"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
