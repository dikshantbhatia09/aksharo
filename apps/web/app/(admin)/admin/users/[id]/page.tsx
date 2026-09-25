"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";

import { Badge, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  AdminTable,
  rowLink,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminUserDetail {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  deviceCount: number;
  adminRoles: string[];
  memberships: { workspaceId: string; workspaceName: string; role: string; status: string }[];
}

function BackToUsers(): React.JSX.Element {
  return (
    <Link
      href="/admin/users"
      className={`${rowLink} inline-flex min-h-8 w-fit items-center text-sm`}
    >
      All users
    </Link>
  );
}

export default function AdminUserDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const adminFetch = useAdminFetch();
  const [user, setUser] = React.useState<AdminUserDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    adminFetch<AdminUserDetail>(`/admin/users/${id}`)
      .then(setUser)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch, id]);

  if (error !== null) {
    return (
      <AdminPage width="form">
        <BackToUsers />
        <AdminError>{error}</AdminError>
      </AdminPage>
    );
  }
  if (user === null) return <AdminLoading />;

  return (
    <AdminPage>
      <div className="flex flex-col gap-4">
        <BackToUsers />
        <PageHeader
          eyebrow="User"
          title={<span className="break-all">{user.email}</span>}
          description={user.name ?? undefined}
        />
      </div>

      <AdminSection title="Account">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-fg-2">Name</dt>
          <dd className="text-fg-0">{user.name ?? "—"}</dd>
          <dt className="text-fg-2">Devices</dt>
          <dd className="text-fg-0 tabular-nums">{user.deviceCount}</dd>
          <dt className="text-fg-2">Admin roles</dt>
          <dd className="flex flex-wrap gap-1.5 text-fg-0">
            {user.adminRoles.length > 0
              ? user.adminRoles.map((role) => <Badge key={role}>{role}</Badge>)
              : "None"}
          </dd>
          <dt className="text-fg-2">Created</dt>
          <dd className="text-fg-0">{new Date(user.createdAt).toLocaleString()}</dd>
          <dt className="text-fg-2">Last seen</dt>
          <dd className="text-fg-0">
            {user.lastSeenAt === null ? "Never" : new Date(user.lastSeenAt).toLocaleString()}
          </dd>
        </dl>
      </AdminSection>

      <AdminSection title="Workspaces" bare>
        {user.memberships.length === 0 ? (
          <AdminEmpty title="Not a member of any workspace" />
        ) : (
          <AdminTable label="Workspace memberships">
            <thead>
              <tr>
                <th className={th}>Workspace</th>
                <th className={th}>Role</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {user.memberships.map((m) => (
                <tr key={m.workspaceId} className={tr}>
                  <td className={td}>
                    <Link href={`/admin/workspaces/${m.workspaceId}`} className={rowLink}>
                      {m.workspaceName}
                    </Link>
                  </td>
                  <td className={td}>{m.role}</td>
                  <td className={td}>{m.status}</td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>
    </AdminPage>
  );
}
