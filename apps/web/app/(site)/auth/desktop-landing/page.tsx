import { Suspense } from "react";

import { DesktopLandingView } from "./landing-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Back to the app", robots: { index: false } };

export default function DesktopLandingPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <DesktopLandingView />
    </Suspense>
  );
}
