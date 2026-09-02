import { LanguagesView } from "./languages-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Languages & defaults" };

export default function LanguagesSettingsPage(): React.JSX.Element {
  return <LanguagesView />;
}
