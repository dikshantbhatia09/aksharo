"use client";

import Link from "next/link";
import * as React from "react";

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
  const [items, setItems] = React.useState<AdminUserSummary[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Users</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email or name"
          className="w-80 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
        />
        <button
          type="submit"
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100"
        >
          Search
        </button>
      </form>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <table className="w-full text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Email</th>
            <th className="py-1 pr-4">Name</th>
            <th className="py-1 pr-4">Admin</th>
            <th className="py-1 pr-4">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((user) => (
            <tr key={user.id} className="border-t border-neutral-800">
              <td className="py-1.5 pr-4">
                <Link href={`/admin/users/${user.id}`} className="underline">
                  {user.email}
                </Link>
              </td>
              <td className="py-1.5 pr-4">{user.name ?? "—"}</td>
              <td className="py-1.5 pr-4">{user.isAdmin ? "yes" : ""}</td>
              <td className="py-1.5 pr-4">{new Date(user.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
