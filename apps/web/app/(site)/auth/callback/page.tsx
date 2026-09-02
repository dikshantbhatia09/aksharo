import { Suspense } from "react";

import { OAuthCallbackView } from "./callback-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Signing you in", robots: { index: false } };

export default function OAuthCallbackPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <OAuthCallbackView />
    </Suspense>
  );
}
