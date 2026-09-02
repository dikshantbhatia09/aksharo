"use client";

import Link from "next/link";
import * as React from "react";

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
  const [items, setItems] = React.useState<AdminWorkspaceSummary[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Workspaces</h1>
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
          placeholder="Search by name or slug"
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
      <ul className="text-sm text-neutral-300">
        {items.map((ws) => (
          <li key={ws.id}>
            <Link href={`/admin/workspaces/${ws.id}`} className="underline">
              {ws.name}
            </Link>{" "}
            ({ws.slug}, {ws.type}, {ws.currency})
          </li>
        ))}
      </ul>
    </div>
  );
}
