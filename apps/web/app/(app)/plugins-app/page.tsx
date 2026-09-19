import { PluginsView } from "./plugins-view";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("plugins");
  return { title: "Plugins" };
}

export default function PluginsPage(): React.JSX.Element {
  assertServerSurfaceEnabled("plugins");
  return <PluginsView />;
}
