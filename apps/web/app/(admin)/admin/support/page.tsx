"use client";

import * as React from "react";

import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface SupportTicket {
  id: string;
  workspaceId: string;
  userId: string;
  subject: string;
  body: string;
  category: string;
  status: string;
  hasDiagnostics: boolean;
  createdAt: string;
  updatedAt: string;
}

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

/**
 * `GET /admin/support/tickets` + `.../:id/status` + `.../:id/reply` (B13b,
 * replacing B13's stub now that `apps/api/src/support/**` (B12) exists).
 */
export default function AdminSupportPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [tickets, setTickets] = React.useState<SupportTicket[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<string>("");
  const [replies, setReplies] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    const query = statusFilter === "" ? "" : `?status=${statusFilter}`;
    adminFetch<SupportTicket[]>(`/admin/support/tickets${query}`)
      .then(setTickets)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch, statusFilter]);

  React.useEffect(load, [load]);

  async function setStatus(id: string, status: string): Promise<void> {
    try {
      await adminFetch(`/admin/support/tickets/${id}/status`, { method: "POST", body: { status } });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Status change failed.");
    }
  }

  async function reply(id: string): Promise<void> {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const body = replies[id]?.trim() ?? "";
    if (body.length === 0) return;
    try {
      await adminFetch(`/admin/support/tickets/${id}/reply`, { method: "POST", body: { body } });
      setReplies((prev) => ({ ...prev, [id]: "" }));
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Reply failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Support</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="status-filter" className="text-neutral-400">
          Status
        </label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        >
          <option value="">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <ul className="flex flex-col gap-3 text-sm text-neutral-300">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="rounded border border-neutral-800 p-3">
            <p className="font-medium text-neutral-100">
              [{ticket.category}] {ticket.subject}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-neutral-400">{ticket.body}</p>
            <p className="mt-1 text-xs text-neutral-500">
              status: {ticket.status}
              {ticket.hasDiagnostics ? " · diagnostics attached" : ""}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <select
                value={ticket.status}
                onChange={(e) => void setStatus(ticket.id, e.target.value)}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={replies[ticket.id] ?? ""}
                onChange={(e) => setReplies((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                placeholder="Reply to this ticket…"
                className="w-80 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              />
              <button
                type="button"
                onClick={() => void reply(ticket.id)}
                className="rounded bg-neutral-800 px-2 py-1"
              >
                Send
              </button>
            </div>
          </li>
        ))}
        {tickets.length === 0 && <p className="text-neutral-500">No tickets.</p>}
      </ul>
    </div>
  );
}
