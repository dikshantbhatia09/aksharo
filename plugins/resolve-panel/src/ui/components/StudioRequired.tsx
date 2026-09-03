import { t } from "../../i18n/strings.js";
import { SIGNAL, TEXT } from "../tokens.js";

import type { JSX } from "react";

/** D24/D65: Workflow Integration plugins are Studio-only; Free installs never load this
 * panel in practice (C10's installer only ships it to Studio), but the panel still shows
 * this guard if it somehow opens on Free. */
export function StudioRequired(): JSX.Element {
  return (
    <div data-testid="studio-required" style={{ padding: 16, color: TEXT.fg0 }}>
      <h2 style={{ color: SIGNAL.rejected, fontSize: 14, margin: "0 0 8px" }}>
        {t("studio.required.title")}
      </h2>
      <p style={{ color: TEXT.fg1, fontSize: 12 }}>{t("studio.required.body")}</p>
    </div>
  );
}
