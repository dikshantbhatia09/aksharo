"use client";

import Link from "next/link";
import * as React from "react";

import { Button, Input, PageHeader } from "@montaj/ui";

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

interface AdminWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  type: string;
  currency: string;
}

export default function AdminWorkspacesPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<AdminWorkspaceSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const search = React.useCallback(async () => {
    setError(null);
    try {
      const result = await adminFetch<{ items: AdminWorkspaceSummary[] }>(
        `/admin/workspaces${query.trim() === "" ? "" : `?query=${encodeURIComponent(query)}`}`,
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
        title="Workspaces"
        description="Find a workspace by name or slug, then open it for its plan, credit balance and owner."
      />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="flex max-w-xl gap-2"
      >
        <label htmlFor="workspace-search" className="sr-only">
          Search workspaces
        </label>
        <Input
          id="workspace-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or slug"
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
        <AdminEmpty title="No workspaces found" />
      ) : (
        <AdminTable label="Workspaces">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Slug</th>
              <th className={th}>Type</th>
              <th className={th}>Currency</th>
            </tr>
          </thead>
          <tbody>
            {items.map((ws) => (
              <tr key={ws.id} className={tr}>
                <td className={td}>
                  <Link href={`/admin/workspaces/${ws.id}`} className={rowLink}>
                    {ws.name}
                  </Link>
                </td>
                <td className={`${td} font-mono text-xs`}>{ws.slug}</td>
                <td className={td}>{ws.type}</td>
                <td className={td}>{ws.currency}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  );
}
