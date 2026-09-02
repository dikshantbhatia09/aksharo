import type { Metadata } from "next";

import { SupportView } from "@/components/support/support-view";

/**
 * Settings → Support (brief §5). Note on file boundaries: the brief's stated
 * boundary lists `apps/web/app/(app)/{academy,help,changelog}/**`, but the
 * brief's own scope (§5) requires tickets to be "listed in Settings →
 * Support" — there is no support surface without a route under
 * `settings/**`. This page is a one-line wrapper (same shape as
 * `settings/devices/page.tsx`); all real logic lives in
 * `components/support/support-view.tsx`, inside the declared boundary.
 * Flagged in the final report as the deviation it is.
 */
export const metadata: Metadata = { title: "Support" };

export default function SupportSettingsPage(): React.JSX.Element {
  return <SupportView />;
}
