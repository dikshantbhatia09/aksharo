import { UiKitView } from "./ui-kit-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "UI kit", robots: { index: false } };

export default function UiKitPage(): React.JSX.Element {
  return <UiKitView />;
}
