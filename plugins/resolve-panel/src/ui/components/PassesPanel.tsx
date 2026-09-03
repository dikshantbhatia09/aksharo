import { t } from "../../i18n/strings.js";
import { ACCENT, SIGNAL, TEXT } from "../tokens.js";

import type { PassesListResult } from "../../passes/passes.js";
import type { JSX } from "react";

export interface PassesPanelProps {
  readonly passes: PassesListResult | undefined;
  readonly applying: boolean;
  readonly applyError: string | undefined;
  readonly onApply: () => void;
}

const STATE_COLOR: Record<string, string> = {
  proposed: SIGNAL.proposed,
  accepted: SIGNAL.accepted,
  rejected: SIGNAL.rejected,
  modified: SIGNAL.info,
};

/** Passes review summary + "Apply in Resolve" (brief item 1). */
export function PassesPanel({
  passes,
  applying,
  applyError,
  onApply,
}: PassesPanelProps): JSX.Element {
  const allItems = passes?.passes.flatMap((pass) => pass.items) ?? [];
  const acceptedCount = allItems.filter((item) => item.state === "accepted").length;

  return (
    <div style={{ padding: 16, borderTop: `1px solid ${TEXT.disabled}` }}>
      <h3 style={{ fontSize: 12, color: TEXT.fg1, margin: "0 0 8px" }}>{t("passes.title")}</h3>
      {allItems.length === 0 ? (
        <div data-testid="passes-empty" style={{ fontSize: 12, color: TEXT.fg2 }}>
          {t("passes.empty")}
        </div>
      ) : (
        <ul data-testid="passes-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {allItems.map((item) => (
            <li
              key={item.itemId}
              data-testid={`pass-item-${item.itemId}`}
              style={{ fontSize: 12, color: STATE_COLOR[item.state] ?? TEXT.fg1 }}
            >
              {item.kind} — {item.state}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        data-testid="apply-button"
        disabled={acceptedCount === 0 || applying}
        onClick={onApply}
        style={{
          marginTop: 8,
          background: ACCENT.lime500,
          color: ACCENT.onAccent,
          border: "none",
          padding: "6px 10px",
          borderRadius: 4,
        }}
      >
        {t("action.applyInResolve")} ({acceptedCount})
      </button>
      {applyError && (
        <div
          data-testid="apply-error"
          style={{ marginTop: 8, fontSize: 12, color: SIGNAL.rejected }}
        >
          {t("status.error", { message: applyError })}
        </div>
      )}
    </div>
  );
}
