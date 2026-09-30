import { BrollLibraryView } from "./broll-library-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "B-roll library" };

export default function BrollSettingsPage(): React.JSX.Element {
  return <BrollLibraryView />;
}
