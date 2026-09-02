import { Suspense } from "react";

import { LoginForm } from "./login-form";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage(): React.JSX.Element {
  // `useSearchParams` opts the subtree into client-side rendering; the boundary
  // keeps the rest of the route static.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
