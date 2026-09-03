"use client";

import * as React from "react";

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
  const [items, setItems] = React.useState<HeldReferral[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">
        Referral review — chained self-referral
      </h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-neutral-300">
        {items.map((item) => (
          <li key={item.id} className="rounded border border-neutral-800 p-3">
            <p>
              Code {item.code} — {item.holdReason}
            </p>
            <p className="text-neutral-500">
              referrer {item.referrerWorkspaceId} → referred {item.referredWorkspaceId}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void approve(item.id)}
                className="rounded bg-neutral-800 px-2 py-1"
              >
                Approve
              </button>
              <input
                value={reasons[item.id] ?? ""}
                onChange={(e) => setReasons((prev) => ({ ...prev, [item.id]: e.target.value }))}
                placeholder="reject reason"
                className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              />
              <button
                type="button"
                onClick={() => void reject(item.id)}
                className="rounded bg-neutral-800 px-2 py-1"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
        {items.length === 0 && <p className="text-neutral-500">Nothing held for review.</p>}
      </ul>
    </div>
  );
}
