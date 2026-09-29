import { NotificationsView } from "./notifications-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Notifications" };

/**
 * Settings > Notifications (2026-09-29). It used to be a placeholder with
 * nothing to choose; the one choice now is device notifications for clips
 * runs, which lives in the browser that makes it (`notifications-view.tsx`).
 */
export default function NotificationsSettingsPage(): React.JSX.Element {
  return <NotificationsView />;
}
