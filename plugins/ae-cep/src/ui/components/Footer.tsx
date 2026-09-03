import { t } from "../../i18n/strings.js";
import { SURFACE, TEXT } from "../tokens.js";

import type { JSX } from "react";

export interface FooterProps {
  readonly panelVersion: string;
  readonly hostVersion?: string;
}

/**
 * Footer version line plus the D65 non-affiliation line, required on every plugin page/panel
 * footer. D65's full product name is "Aksharo Panel — works with Adobe Premiere Pro and Adobe
 * After Effects"; the brief for this WP shortens the footer line to the After Effects half
 * since that's the only host this panel runs in.
 */
export function Footer({ panelVersion, hostVersion }: FooterProps): JSX.Element {
  const versionLine = hostVersion
    ? `Aksharo Panel v${panelVersion} · After Effects ${hostVersion}`
    : `Aksharo Panel v${panelVersion}`;

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
