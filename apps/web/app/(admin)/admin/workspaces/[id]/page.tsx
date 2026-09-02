"use client";

import { useParams } from "next/navigation";
import * as React from "react";

import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminWorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  ownerEmail?: string;
  memberCount: number;
  currency: string;
  creditAccount?: { balanceTenths: number; monthlyGrantTenths: number; negativeAllowed: boolean };
  subscription?: { planId: string; status: string; currentPeriodEnd: string };
}

export default function AdminWorkspaceDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const adminFetch = useAdminFetch();
  const [ws, setWs] = React.useState<AdminWorkspaceDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    adminFetch<AdminWorkspaceDetail>(`/admin/workspaces/${id}`)
      .then(setWs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch, id]);

  if (error !== null) return <p className="text-sm text-red-400">{error}</p>;
  if (ws === null) return <p className="text-sm text-neutral-400">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">{ws.name}</h1>
      <dl className="grid grid-cols-2 gap-2 text-sm text-neutral-300">
        <dt className="text-neutral-500">Owner</dt>
        <dd>{ws.ownerEmail ?? "—"}</dd>
        <dt className="text-neutral-500">Members</dt>
        <dd>{ws.memberCount}</dd>
        <dt className="text-neutral-500">Currency</dt>
        <dd>{ws.currency}</dd>
        <dt className="text-neutral-500">Credit balance</dt>
        <dd>
          {ws.creditAccount === undefined
            ? "—"
            : `${String(ws.creditAccount.balanceTenths / 10)} credits`}
        </dd>
        <dt className="text-neutral-500">Plan</dt>
        <dd>
          {ws.subscription === undefined
            ? "free"
            : `${ws.subscription.planId} (${ws.subscription.status})`}
        </dd>
      </dl>
      <a
        href={`/admin/credits?workspaceId=${ws.id}`}
        className="w-fit rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100"
      >
        Adjust credits
      </a>
    </div>
  );
}
