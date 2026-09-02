import { LicenseKeysView } from "./license-keys-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Licence keys" };

export default function LicenseKeysPage(): React.JSX.Element {
  return <LicenseKeysView />;
}
