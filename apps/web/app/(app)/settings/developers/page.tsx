import { DevelopersView } from "./developers-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Developers" };

export default function DevelopersSettingsPage(): React.JSX.Element {
  return <DevelopersView />;
}
