"use client";

import { useParams } from "next/navigation";
import * as React from "react";

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

  if (error !== null) return <p className="text-sm text-red-400">{error}</p>;
  if (user === null) return <p className="text-sm text-neutral-400">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">{user.email}</h1>
      <dl className="grid grid-cols-2 gap-2 text-sm text-neutral-300">
        <dt className="text-neutral-500">Name</dt>
        <dd>{user.name ?? "—"}</dd>
        <dt className="text-neutral-500">Devices</dt>
        <dd>{user.deviceCount}</dd>
        <dt className="text-neutral-500">Admin roles</dt>
        <dd>{user.adminRoles.length > 0 ? user.adminRoles.join(", ") : "none"}</dd>
        <dt className="text-neutral-500">Last seen</dt>
        <dd>{user.lastSeenAt === null ? "never" : new Date(user.lastSeenAt).toLocaleString()}</dd>
      </dl>
      <h2 className="mt-2 text-sm font-semibold text-neutral-200">Workspaces</h2>
      <ul className="text-sm text-neutral-300">
        {user.memberships.map((m) => (
          <li key={m.workspaceId}>
            {m.workspaceName} — {m.role} ({m.status})
          </li>
        ))}
      </ul>
    </div>
  );
}
