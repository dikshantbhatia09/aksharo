import { ProfileView } from "./profile-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Profile" };

export default function ProfileSettingsPage(): React.JSX.Element {
  return <ProfileView />;
}
