import { t } from "../../i18n/strings.js";
import { ACCENT, SIGNAL, TEXT } from "../tokens.js";

import type { UpdateBannerState } from "../../version/manifestCheck.js";
import type { JSX } from "react";

export interface UpdateBannerProps {
  readonly state: UpdateBannerState;
  readonly currentVersion: string;
}

/** `/plugins/manifest` min/max-version banner (D65). Renders nothing when `state.show` is false. */
export function UpdateBanner({ state, currentVersion }: UpdateBannerProps): JSX.Element | null {
  if (!state.show) return null;

  const color = state.severity === "unsupported" ? SIGNAL.rejected : ACCENT.lime500;
  const text = t("updateBanner.text", {
    latest: state.latestVersion ?? "?",
    current: currentVersion,
  });

  return (
    <div
      role="alert"
      data-testid="update-banner"
      data-severity={state.severity}
      style={{
        padding: "6px 10px",
        fontSize: 12,
        color: TEXT.fg0,
        borderLeft: `3px solid ${color}`,
      }}
    >
      {text}
    </div>
  );
}
