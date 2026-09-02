"use client";

import * as React from "react";

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
  const [items, setItems] = React.useState<RoutingWeightOverride[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Routing weight overrides</h1>
      <p className="text-xs text-neutral-500">
        Overrides the admin console's own record only — the worker still reads routing.yaml; see the
        final report's open questions.
      </p>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <table className="w-full max-w-md text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Lane</th>
            <th className="py-1 pr-4">Provider</th>
            <th className="py-1 pr-4">Weight</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id} className="border-t border-neutral-800">
              <td className="py-1 pr-4">{o.laneId}</td>
              <td className="py-1 pr-4">{o.provider}</td>
              <td className="py-1 pr-4">{o.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={submit} className="flex max-w-md flex-col gap-2 text-sm">
        <input
          value={laneId}
          onChange={(e) => setLaneId(e.target.value)}
          placeholder="lane id (e.g. hinglish)"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        />
        <input
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="provider (e.g. elevenlabs)"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        />
        <input
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          placeholder="weight 0-100"
          type="number"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (min 10 chars)"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        />
        <button type="submit" className="w-fit rounded bg-neutral-800 px-3 py-1.5 text-neutral-100">
          Set
        </button>
      </form>
    </div>
  );
}
