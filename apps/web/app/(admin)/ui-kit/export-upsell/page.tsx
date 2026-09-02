import { ExportUpsellPanelDemo } from "./export-upsell-demo";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Export upsell — UI kit" };

/**
 * Standalone route to exercise `ExportUpsellPanel` (B04) without the editor's
 * export dialog, which had not landed at the time of this work package (A15/
 * A19). Signed in against a real workspace, this renders exactly what the
 * dialog will mount — see the panel's own file header for the integration
 * contract (`onCleanManifestReady`).
 */
export default function ExportUpsellUiKitPage(): React.JSX.Element {
  return <ExportUpsellPanelDemo />;
}
