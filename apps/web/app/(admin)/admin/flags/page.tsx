"use client";

import * as React from "react";

import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface FeatureFlag {
  id: string;
  key: string;
  enabled: boolean;
  rolloutPct: number;
}

/** `GET /admin/flags` (any role) + `PUT /admin/flags/:key` (superadmin only, reason required). */
export default function AdminFlagsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [flags, setFlags] = React.useState<FeatureFlag[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reasons, setReasons] = React.useState<Record<string, string>>({});

  const load = React.useCallback(() => {
    adminFetch<FeatureFlag[]>("/admin/flags")
      .then(setFlags)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function toggle(flag: FeatureFlag): Promise<void> {
    const reason = reasons[flag.key]?.trim() ?? "";
    if (reason.length < 10) {
      setError("A reason (min 10 characters) is required to change a flag.");
      return;
    }
    try {
      await adminFetch(`/admin/flags/${flag.key}`, {
        method: "PUT",
        body: { enabled: !flag.enabled, reason },
      });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Update failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Feature flags</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <table className="w-full text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Key</th>
            <th className="py-1 pr-4">Enabled</th>
            <th className="py-1 pr-4">Rollout %</th>
            <th className="py-1 pr-4">Reason</th>
            <th className="py-1 pr-4" />
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <tr key={flag.id} className="border-t border-neutral-800">
              <td className="py-1.5 pr-4">{flag.key}</td>
              <td className="py-1.5 pr-4">{flag.enabled ? "on" : "off"}</td>
              <td className="py-1.5 pr-4">{flag.rolloutPct}</td>
              <td className="py-1.5 pr-4">
                <input
                  value={reasons[flag.key] ?? ""}
                  onChange={(e) => setReasons((prev) => ({ ...prev, [flag.key]: e.target.value }))}
                  placeholder="why"
                  className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
                />
              </td>
              <td className="py-1.5 pr-4">
                <button
                  type="button"
                  onClick={() => void toggle(flag)}
                  className="rounded bg-neutral-800 px-2 py-1 text-neutral-100"
                >
                  Toggle
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
