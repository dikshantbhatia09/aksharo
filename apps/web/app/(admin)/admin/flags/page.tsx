"use client";

import * as React from "react";

import { Badge, Button, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
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
  const [flags, setFlags] = React.useState<FeatureFlag[] | null>(null);
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
    <AdminPage>
      <PageHeader
        eyebrow="Platform"
        title="Feature flags"
        description="A change applies to every workspace in the flag's rollout. Superadmin only: write a reason of at least 10 characters, then turn the flag on or off."
      />
      {error !== null && <AdminError>{error}</AdminError>}
      {flags === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : flags.length === 0 ? (
        <AdminEmpty title="No flags defined" />
      ) : (
        <AdminTable label="Feature flags">
          <thead>
            <tr>
              <th className={th}>Key</th>
              <th className={th}>State</th>
              <th className={`${th} text-right`}>Rollout</th>
              <th className={th}>Reason</th>
              <th className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <tr key={flag.id} className={tr}>
                <td className={`${td} font-mono text-xs text-fg-0`}>{flag.key}</td>
                <td className={td}>
                  {flag.enabled ? <Badge tone="accepted">On</Badge> : <Badge>Off</Badge>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{flag.rolloutPct}%</td>
                <td className={td}>
                  <Input
                    aria-label={`Reason for changing ${flag.key}`}
                    value={reasons[flag.key] ?? ""}
                    onChange={(e) =>
                      setReasons((prev) => ({ ...prev, [flag.key]: e.target.value }))
                    }
                    placeholder="Why this change"
                    className="h-8 min-w-48"
                  />
                </td>
                <td className={`${td} text-right`}>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`${flag.enabled ? "Turn off" : "Turn on"} ${flag.key}`}
                    onClick={() => void toggle(flag)}
                  >
                    {flag.enabled ? "Turn off" : "Turn on"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  );
}
