"use client";

/**
 * "Reflow captions for this style" — the orchestrator addendum after A16c/d
 * (decision D78). Shown only when the style or aspect now measures a
 * different `fitBudget` than the budget the document was segmented with;
 * never resegments on its own, because that would silently invalidate manual
 * splits, merges and hidden captions.
 */
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
        "flex items-center justify-between gap-3 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-sm",
        className,
      )}
    >
      <span>This style fits captions differently now. Reflow to re-cut lines for it?</span>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="reflow-banner-apply"
          disabled={busy}
          className={cn(
            "rounded-md bg-sky-400 px-2.5 py-1 font-medium text-black",
            busy && "cursor-wait opacity-60",
          )}
          onClick={onReflow}
        >
          {busy ? "Reflowing…" : "Reflow captions"}
        </button>
        <button
          type="button"
          data-testid="reflow-banner-dismiss"
          className="text-fg-3 px-2 py-1 hover:underline"
          onClick={onDismiss}
        >
          Not now
        </button>
      </span>
    </div>
  );
}
