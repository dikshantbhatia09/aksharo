import { BrandKitView } from "./brand-kit-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Brand kit" };

export default function BrandKitSettingsPage(): React.JSX.Element {
  return <BrandKitView />;
}
