import { t } from "../../i18n/strings.js";
import { SURFACE, TEXT } from "../tokens.js";

import type { JSX } from "react";

export interface FooterProps {
  readonly panelVersion: string;
  readonly apiVersion: string;
  readonly hostVersion?: string;
}

/**
 * Footer version line (08 §4 "Panel UI": `panel 1.0.0 · Premiere 25.2 · bridge 1.0.0`, adapted
 * here per the brief to `Aksharo Panel vX.Y.Z · API vN`) plus the D65 non-affiliation line,
 * required on every plugin page/panel footer.
 */
export function Footer({ panelVersion, apiVersion, hostVersion }: FooterProps): JSX.Element {
  const versionLine = hostVersion
    ? `Aksharo Panel v${panelVersion} · API v${apiVersion} · Premiere ${hostVersion}`
    : `Aksharo Panel v${panelVersion} · API v${apiVersion}`;

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
