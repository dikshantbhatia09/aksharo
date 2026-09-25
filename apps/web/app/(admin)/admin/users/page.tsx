"use client";

import Link from "next/link";
import * as React from "react";

import { Badge, Button, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminTable,
  rowLink,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** `GET /admin/users` — search by email/name. Any admin role may view. */
export default function AdminUsersPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<AdminUserSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const search = React.useCallback(async () => {
    setError(null);
    try {
      const result = await adminFetch<{ items: AdminUserSummary[] }>(
        `/admin/users${query.trim() === "" ? "" : `?query=${encodeURIComponent(query)}`}`,
      );
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    }
  }, [adminFetch, query]);

  React.useEffect(() => {
    void search();
  }, []);

  return (
    <AdminPage>
      <PageHeader
        eyebrow="People"
        title="Users"
        description="Find an account by email or name, then open it for its workspaces and admin roles."
      />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="flex max-w-xl gap-2"
      >
        <label htmlFor="user-search" className="sr-only">
          Search users
        </label>
        <Input
          id="user-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email or name"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {error !== null && <AdminError>{error}</AdminError>}
      {items === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : items.length === 0 ? (
        <AdminEmpty
          title="No users found"
          description={query.trim() === "" ? undefined : "Try part of the email address instead."}
        />
      ) : (
        <AdminTable label="Users">
          <thead>
            <tr>
              <th className={th}>Email</th>
              <th className={th}>Name</th>
              <th className={th}>Role</th>
              <th className={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className={tr}>
                <td className={td}>
                  <Link href={`/admin/users/${user.id}`} className={rowLink}>
                    {user.email}
                  </Link>
                </td>
                <td className={td}>{user.name ?? "—"}</td>
                <td className={td}>{user.isAdmin ? <Badge>Admin</Badge> : null}</td>
                <td className={`${td} whitespace-nowrap text-fg-2`}>
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  );
}
