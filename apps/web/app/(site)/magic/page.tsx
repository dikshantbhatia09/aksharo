import { Suspense } from "react";

import { MagicView } from "./magic-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in with a link" };

export default function MagicPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <MagicView />
    </Suspense>
  );
}
