import { IntegrationsView } from "./integrations-view";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meeting & Studio Connectors",
  description: "Connect Zoom Cloud, Riverside.fm, and Google Meet for automatic multi-speaker ingestion.",
};

export default function IntegrationsSettingsPage(): React.JSX.Element {
  return <IntegrationsView />;
}

