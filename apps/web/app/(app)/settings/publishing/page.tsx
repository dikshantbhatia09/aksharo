import { PublishingView } from "./publishing-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Publishing" };

export default function PublishingSettingsPage(): React.JSX.Element {
  return <PublishingView />;
}
