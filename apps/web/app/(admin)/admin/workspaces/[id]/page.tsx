"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";

import { Badge, Button, PageHeader } from "@montaj/ui";

import {
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  rowLink,
} from "@/components/admin/admin-ui";
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

function BackToWorkspaces(): React.JSX.Element {
  return (
    <Link
      href="/admin/workspaces"
      className={`${rowLink} inline-flex min-h-8 w-fit items-center text-sm`}
    >
      All workspaces
    </Link>
  );
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

  if (error !== null) {
    return (
      <AdminPage width="form">
        <BackToWorkspaces />
        <AdminError>{error}</AdminError>
      </AdminPage>
    );
  }
  if (ws === null) return <AdminLoading />;

  return (
    <AdminPage>
      <div className="flex flex-col gap-4">
        <BackToWorkspaces />
        <PageHeader
          eyebrow="Workspace"
          title={ws.name}
          description={<span className="font-mono text-xs">{ws.slug}</span>}
          actions={
            <Button asChild variant="primary">
              <Link href={`/admin/credits?workspaceId=${ws.id}`}>Adjust credits</Link>
            </Button>
          }
        />
      </div>

      <AdminSection title="Overview">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-fg-2">Owner</dt>
          <dd className="break-all text-fg-0">{ws.ownerEmail ?? "—"}</dd>
          <dt className="text-fg-2">Members</dt>
          <dd className="text-fg-0 tabular-nums">{ws.memberCount}</dd>
          <dt className="text-fg-2">Currency</dt>
          <dd className="text-fg-0">{ws.currency}</dd>
          <dt className="text-fg-2">Credit balance</dt>
          <dd className="text-fg-0 tabular-nums">
            {ws.creditAccount === undefined
              ? "—"
              : `${String(ws.creditAccount.balanceTenths / 10)} credits`}
          </dd>
          <dt className="text-fg-2">Plan</dt>
          <dd className="flex flex-wrap items-center gap-2 text-fg-0">
            {ws.subscription === undefined ? (
              "Free"
            ) : (
              <>
                {ws.subscription.planId}
                <Badge>{ws.subscription.status}</Badge>
              </>
            )}
          </dd>
        </dl>
      </AdminSection>
    </AdminPage>
  );
}
