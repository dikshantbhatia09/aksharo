"use client";

import * as React from "react";

import { Button, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  adminCard,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface HeldReferral {
  id: string;
  referrerWorkspaceId: string;
  referredWorkspaceId: string;
  code: string;
  holdReason: string;
}

/** Chained-self-referral review queue (`GET .../review-queue`, `POST .../approve|reject`). */
export default function AdminReferralsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [items, setItems] = React.useState<HeldReferral[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reasons, setReasons] = React.useState<Record<string, string>>({});

  const load = React.useCallback(() => {
    adminFetch<HeldReferral[]>("/admin/referrals/review-queue")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function approve(id: string): Promise<void> {
    try {
      await adminFetch(`/admin/referrals/${id}/approve`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Approve failed.");
    }
  }

  async function reject(id: string): Promise<void> {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const reason = reasons[id]?.trim() ?? "";
    if (reason.length < 10) {
      setError("A reason (min 10 characters) is required to reject.");
      return;
    }
    try {
      await adminFetch(`/admin/referrals/${id}/reject`, { method: "POST", body: { reason } });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Reject failed.");
    }
  }

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Money"
        title="Referral review"
        description="Referrals held because they look like a chained self-referral. Approve or reject each one; rejecting needs a reason of at least 10 characters."
      />
      {error !== null && <AdminError>{error}</AdminError>}
      {items === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : items.length === 0 ? (
        <AdminEmpty title="Nothing held for review" description="New holds appear here." />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id} className={`${adminCard} flex flex-col gap-3`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg-0">
                  Code <span className="font-mono">{item.code}</span>
                </p>
                <p className="text-sm text-fg-1">{item.holdReason}</p>
                <p className="mt-1 font-mono text-xs break-all text-fg-2">
                  referrer {item.referrerWorkspaceId} → referred {item.referredWorkspaceId}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button variant="secondary" size="sm" onClick={() => void approve(item.id)}>
                  Approve
                </Button>
                <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
                <Input
                  aria-label={`Reason for rejecting code ${item.code}`}
                  value={reasons[item.id] ?? ""}
                  onChange={(e) => setReasons((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Reason to reject"
                  className="h-8 sm:max-w-64"
                />
                <Button variant="secondary" size="sm" onClick={() => void reject(item.id)}>
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminPage>
  );
}
