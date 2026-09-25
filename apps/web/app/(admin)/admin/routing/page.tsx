"use client";

import * as React from "react";

import { Button, Field, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface RoutingWeightOverride {
  id: string;
  laneId: string;
  provider: string;
  weight: number;
}

/** Routing weight overrides — superadmin only. Does not affect the worker (see final report). */
export default function AdminRoutingPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [items, setItems] = React.useState<RoutingWeightOverride[] | null>(null);
  const [laneId, setLaneId] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [weight, setWeight] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    adminFetch<RoutingWeightOverride[]>("/admin/routing/weights")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await adminFetch("/admin/routing/weights", {
        method: "PUT",
        body: { laneId, provider, weight: Number(weight), reason },
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
        title="Routing weight overrides"
        description="Superadmin only. These are recorded here but not yet read by the transcription worker, which still routes from routing.yaml."
      />
      {error !== null && <AdminError>{error}</AdminError>}

      <AdminSection title="Current overrides" bare>
        {items === null ? (
          error === null ? (
            <AdminLoading />
          ) : null
        ) : items.length === 0 ? (
          <AdminEmpty title="No overrides" description="Add one below." />
        ) : (
          <AdminTable label="Routing weight overrides" className="max-w-2xl">
            <thead>
              <tr>
                <th className={th}>Lane</th>
                <th className={th}>Provider</th>
                <th className={`${th} text-right`}>Weight</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id} className={tr}>
                  <td className={`${td} font-mono text-xs text-fg-0`}>{o.laneId}</td>
                  <td className={td}>{o.provider}</td>
                  <td className={`${td} text-right tabular-nums`}>{o.weight}</td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>

      <AdminSection title="Set an override" className="max-w-2xl">
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Lane ID" htmlFor="routing-lane" hint="For example hinglish">
            <Input
              id="routing-lane"
              value={laneId}
              onChange={(e) => setLaneId(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field label="Provider" htmlFor="routing-provider" hint="For example elevenlabs">
            <Input
              id="routing-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field label="Weight" htmlFor="routing-weight" hint="0 to 100">
            <Input
              id="routing-weight"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              type="number"
              inputMode="numeric"
            />
          </Field>
          <Field label="Reason (min 10 characters)" htmlFor="routing-reason">
            <Input id="routing-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary">
              Save override
            </Button>
          </div>
        </form>
      </AdminSection>
    </AdminPage>
  );
}
