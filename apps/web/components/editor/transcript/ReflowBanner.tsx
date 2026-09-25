"use client";

/**
 * "Reflow captions for this style" — the orchestrator addendum after A16c/d
 * (decision D78). Shown only when the style or aspect now measures a
 * different `fitBudget` than the budget the document was segmented with;
 * never resegments on its own, because that would silently invalidate manual
 * splits, merges and hidden captions.
 */
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ReflowBannerProps {
  readonly visible: boolean;
  readonly onReflow: () => void;
  readonly onDismiss: () => void;
  readonly busy?: boolean;
  readonly className?: string;
}

export function ReflowBanner({
  visible,
  onReflow,
  onDismiss,
  busy = false,
  className,
}: ReflowBannerProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <div
      role="status"
      data-testid="reflow-banner"
      className={cn(
        "border-proposed/40 bg-proposed/10 text-fg-1 flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-sm",
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <TriangleAlert className="text-proposed size-4 shrink-0" aria-hidden="true" />
        This style fits captions differently now. Reflow to re-cut lines for it?
      </span>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="reflow-banner-apply"
          disabled={busy}
          className={cn(
            "border-border text-fg-0 hover:bg-neutral-100/7 active:bg-neutral-100/14 flex h-8 items-center rounded-sm border px-3 text-xs font-medium transition-colors duration-[160ms]",
            busy && "cursor-wait opacity-60",
          )}
          onClick={onReflow}
        >
          {busy ? "Reflowing…" : "Reflow captions"}
        </button>
        <button
          type="button"
          data-testid="reflow-banner-dismiss"
          className="text-fg-2 hover:text-fg-0 flex h-8 items-center rounded-sm px-2 text-xs transition-colors duration-[160ms]"
          onClick={onDismiss}
        >
          Not now
        </button>
      </span>
    </div>
  );
}
