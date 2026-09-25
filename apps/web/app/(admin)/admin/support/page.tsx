"use client";

import * as React from "react";

import { Badge, Button, PageHeader, Textarea } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSelect,
  adminCard,
} from "@/components/admin/admin-ui";
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

/** Sentence-case words for the stored status codes; the API still gets the code. */
function statusLabel(status: string): string {
  const spaced = status.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * `GET /admin/support/tickets` + `.../:id/status` + `.../:id/reply` (B13b,
 * replacing B13's stub now that `apps/api/src/support/**` (B12) exists).
 */
export default function AdminSupportPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [tickets, setTickets] = React.useState<SupportTicket[] | null>(null);
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
    <AdminPage>
      <PageHeader
        eyebrow="People"
        title="Support"
        description="Tickets from every workspace. Change a ticket's status or reply to the person who raised it."
        actions={
          <label htmlFor="status-filter" className="flex items-center gap-2 text-sm text-fg-1">
            Show
            <AdminSelect
              id="status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All tickets</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </AdminSelect>
          </label>
        }
      />
      {error !== null && <AdminError>{error}</AdminError>}

      {tickets === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : tickets.length === 0 ? (
        <AdminEmpty
          title="No tickets"
          description={statusFilter === "" ? undefined : "None have this status."}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {tickets.map((ticket) => {
            const replyId = `reply-${ticket.id}`;
            const statusId = `status-${ticket.id}`;
            return (
              <li key={ticket.id} className={`${adminCard} flex flex-col gap-4`}>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{ticket.category}</Badge>
                    {ticket.hasDiagnostics ? <Badge tone="info">Diagnostics attached</Badge> : null}
                    <span className="text-xs text-fg-2">
                      {new Date(ticket.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-base font-semibold text-fg-0">{ticket.subject}</p>
                  <p className="text-sm whitespace-pre-wrap text-fg-1">{ticket.body}</p>
                </div>
                <div className="flex flex-col gap-3 border-t border-border pt-4">
                  <div className="flex items-center gap-2">
                    <label htmlFor={statusId} className="text-sm text-fg-1">
                      Status
                    </label>
                    <AdminSelect
                      id={statusId}
                      value={ticket.status}
                      onChange={(e) => void setStatus(ticket.id, e.target.value)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {statusLabel(s)}
                        </option>
                      ))}
                    </AdminSelect>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label htmlFor={replyId} className="text-sm text-fg-1">
                      Reply
                    </label>
                    <Textarea
                      id={replyId}
                      value={replies[ticket.id] ?? ""}
                      onChange={(e) =>
                        setReplies((prev) => ({ ...prev, [ticket.id]: e.target.value }))
                      }
                      placeholder="Write to the person who raised this ticket"
                      className="min-h-16"
                    />
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => void reply(ticket.id)}>
                        Send reply
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AdminPage>
  );
}
