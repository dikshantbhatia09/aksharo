import { t } from "../../i18n/strings.js";
import { SURFACE, TEXT } from "../tokens.js";

import type { JSX } from "react";

export interface FooterProps {
  readonly panelVersion: string;
  readonly apiVersion: string;
  readonly hostVersion?: string;
}

/** Footer version line (08 §4 "Panel UI" pattern, adapted per the brief: "version line +
 * update banner from `/plugins/manifest`") plus the D65 non-affiliation line, required on
 * every page/panel footer that mentions DaVinci Resolve. */
export function Footer({ panelVersion, apiVersion, hostVersion }: FooterProps): JSX.Element {
  const versionLine = hostVersion
    ? `Aksharo v${panelVersion} · API v${apiVersion} · Resolve ${hostVersion}`
    : `Aksharo v${panelVersion} · API v${apiVersion}`;

  return (
    <footer
      style={{
        borderTop: `1px solid ${SURFACE.border}`,
        padding: "8px 12px",
        fontSize: 11,
        color: TEXT.fg2,
        lineHeight: 1.4,
      }}
    >
      <div data-testid="footer-version-line">{versionLine}</div>
      <div data-testid="footer-non-affiliation">{t("footer.nonAffiliation")}</div>
    </footer>
  );
}
