import { OnboardingFlow } from "./onboarding-flow";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Set up your account" };

export default function OnboardingPage(): React.JSX.Element {
  return <OnboardingFlow />;
}
