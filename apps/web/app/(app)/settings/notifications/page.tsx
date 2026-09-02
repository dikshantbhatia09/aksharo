import { BRAND } from "@montaj/config";
import { Card } from "@montaj/ui";

import type { Metadata } from "next";

import { SettingsSection } from "@/components/settings/section";

export const metadata: Metadata = { title: "Notifications" };

/**
 * A placeholder on purpose (brief §6). There is no notification preference to
 * store until A25 owns delivery and B12 owns the in-app feed, and offering
 * switches that do nothing is worse than saying so.
 */
export default function NotificationsSettingsPage(): React.JSX.Element {
  return (
    <SettingsSection
      title="Notifications"
      description="What we email you about."
      testId="settings-notifications"
    >
      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-medium">Nothing to choose yet</h2>
        <p className="text-fg-2 text-sm">
          Right now {BRAND.name} only emails you about your account: confirming your address,
          sign-in links, and approving a device. Those are not optional, and there is nothing else
          being sent.
        </p>
        <p className="text-fg-2 text-sm">
          Product emails are a separate consent, under Privacy. When job and export notifications
          arrive, their switches will be here.
        </p>
      </Card>
    </SettingsSection>
  );
}
