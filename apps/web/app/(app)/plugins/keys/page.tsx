import { LicenseKeysView } from "./license-keys-view";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("plugins");
  return { title: "Licence keys" };
}

export default function LicenseKeysPage(): React.JSX.Element {
  assertServerSurfaceEnabled("plugins");
  return <LicenseKeysView />;
}
