"use client";

import * as React from "react";

import { useReferralStats } from "@montaj/api-client";
import { Card, Skeleton } from "@montaj/ui";

import { ReferralShareRow } from "./referral-share-row";

/**
 * The Invite-friends tab content for the Refer & Earn page (brief §3).
 *
 * **Mount point.** B07 owns the Refer & Earn page shell (tab navigation,
 * route, layout) and has not landed on `main` yet, so this ships as a
 * standalone component rather than wired into a page — this work package's
 * file boundary is `apps/web/components/referrals/**`. Once B07's page
 * exists, mount `<InviteFriendsTab />` as the content of its "Invite
 * friends" tab; it needs no props (it reads its own data through
 * `useReferralStats()`).
 */
export function InviteFriendsTab(): React.JSX.Element {
  const stats = useReferralStats();

  if (stats.isPending) {
    return (
      <div className="flex flex-col gap-4" data-testid="invite-friends-tab">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (stats.data === undefined) {
    return (
      <p className="text-fg-2 text-sm" data-testid="invite-friends-tab">
        Could not load your referral code. Try again in a moment.
      </p>
    );
  }

  const { code, pending, granted, rejected, bonusGrantedAt } = stats.data;

  return (
    <div className="flex flex-col gap-6" data-testid="invite-friends-tab">
      <Card className="flex flex-col gap-1 p-5">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          Give 30 credits, get 30 credits
        </h2>
        <p className="text-fg-2 text-sm">
          Share your code with a friend. When they complete their first export, you both get 30
          credits — free, and they never expire.
        </p>
      </Card>

      <ReferralShareRow code={code} />

      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Pending" value={pending} testId="referral-stat-pending" />
        <Stat label="Granted" value={granted} testId="referral-stat-granted" />
        <Stat label="Not eligible" value={rejected} testId="referral-stat-rejected" />
      </dl>

      {bonusGrantedAt !== null ? (
        <p className="text-fg-2 text-sm" data-testid="referral-bonus-earned">
          You've earned the 100-credit bonus for 3 successful referrals. Thank you!
        </p>
      ) : (
        <p className="text-fg-2 text-sm">
          Refer 3 friends who complete an export and earn a 100-credit bonus.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}): React.JSX.Element {
  return (
    <Card className="flex flex-col gap-1 p-4" data-testid={testId}>
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd className="font-display text-2xl font-semibold tracking-tight">{value}</dd>
    </Card>
  );
}
