import { PluginsView } from "./plugins-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Plugins" };

export default function PluginsPage(): React.JSX.Element {
  return <PluginsView />;
}
