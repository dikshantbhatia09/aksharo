import { PrivacyView } from "./privacy-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacySettingsPage(): React.JSX.Element {
  return <PrivacyView />;
}
