import { DevicesView } from "./devices-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Devices & sessions" };

export default function DevicesSettingsPage(): React.JSX.Element {
  return <DevicesView />;
}
