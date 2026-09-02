import { SignUpForm } from "./signup-form";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage(): React.JSX.Element {
  return <SignUpForm />;
}
