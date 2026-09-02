import { Suspense } from "react";

import { VerifyView } from "./verify-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Confirm your email" };

export default function VerifyPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <VerifyView />
    </Suspense>
  );
}
