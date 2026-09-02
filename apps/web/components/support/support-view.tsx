"use client";

import * as React from "react";

import { useApiClient, useCreateSupportTicket, useSupportTickets, useWorkspaceId, endpoints } from "@montaj/api-client";
import type { SupportCategory, SupportDiagnostics } from "@montaj/api-client";
import { Badge, Button, Card, Checkbox, Field, Skeleton, Textarea, toast } from "@montaj/ui";

import {
  APP_VERSION,
  describeUserAgent,
  installConsoleErrorRingBuffer,
  recentConsoleErrors,
} from "./diagnostics";

import { SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";



const CATEGORIES: { value: SupportCategory; label: string }[] = [
  { value: "bug", label: "Something's broken" },
  { value: "billing", label: "Billing" },
  { value: "export", label: "Export or a job" },
  { value: "account", label: "Account" },
  { value: "other", label: "Something else" },
];

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

/**
 * Settings → Support (brief §5): file a ticket, optionally with a
 * consent-gated diagnostics bundle, and see this workspace's own tickets
 * with their status.
 */
export function SupportView(): React.JSX.Element {
  React.useEffect(() => {
    installConsoleErrorRingBuffer();
  }, []);

  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const tickets = useSupportTickets();
  const createTicket = useCreateSupportTicket();

  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [category, setCategory] = React.useState<SupportCategory>("bug");
  const [includeDiagnostics, setIncludeDiagnostics] = React.useState(true);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (subject.trim() === "" || body.trim() === "" || workspaceId === null) return;

    let diagnostics: SupportDiagnostics | undefined;
    if (includeDiagnostics) {
      const { browser, os } = describeUserAgent();
      let jobs: SupportDiagnostics["jobs"] = [];
      try {
        const page = await client.call(endpoints.jobs.list, { query: { limit: 10 } });
        jobs = page.items.slice(0, 10).map((job) => ({ jobId: job.id, status: job.status }));
      } catch {
        jobs = []; // Best-effort: a ticket must not fail to send because the job list did.
      }
      diagnostics = {
        appVersion: APP_VERSION,
        browser,
        os,
        workspaceId,
        jobs,
        consoleErrors: recentConsoleErrors(),
      };
    }

    createTicket.mutate(
      { subject: subject.trim(), body: body.trim(), category, diagnostics },
      {
        onSuccess: () => {
          toast.success("Ticket sent", { description: "We'll get back to you by email." });
          setSubject("");
          setBody("");
          setCategory("bug");
        },
        onError: (error) => {
          toast.error("Could not send that ticket", { description: messageForError(error) });
        },
      },
    );
  }

  return (
    <SettingsSection
      title="Support"
      description="File a ticket and track its status."
      testId="settings-support"
    >
      <Card className="p-5">
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} data-testid="support-ticket-form">
          <Field label="Subject" htmlFor="support-subject">
            <input
              id="support-subject"
              className="border-border bg-bg-1 h-9 rounded-md border px-3 text-sm"
              value={subject}
              maxLength={160}
              onChange={(event) => setSubject(event.target.value)}
              required
              data-testid="support-subject"
            />
          </Field>

          <Field label="Category" htmlFor="support-category">
            <select
              id="support-category"
              className="border-border bg-bg-1 h-9 rounded-md border px-3 text-sm"
              value={category}
              onChange={(event) => setCategory(event.target.value as SupportCategory)}
              data-testid="support-category"
            >
              {CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="What's going on?" htmlFor="support-body">
            <Textarea
              id="support-body"
              value={body}
              maxLength={5_000}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              required
              data-testid="support-body"
            />
          </Field>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={includeDiagnostics}
              onCheckedChange={(checked) => setIncludeDiagnostics(checked === true)}
              data-testid="support-include-diagnostics"
            />
            <span className="text-fg-1">
              Include diagnostics (app version, browser/OS, workspace id, your last 10 job
              statuses, recent console errors). Never includes your media or transcript.
            </span>
          </label>

          <Button type="submit" disabled={createTicket.isPending} data-testid="support-submit">
            {createTicket.isPending ? "Sending…" : "Send"}
          </Button>
        </form>
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-sm font-semibold">Your tickets</h2>
        {tickets.isPending ? (
          <Skeleton className="h-16" />
        ) : (tickets.data?.tickets.length ?? 0) === 0 ? (
          <p className="text-fg-2 text-sm">No tickets yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="support-ticket-list">
            {tickets.data?.tickets.map((ticket) => (
              <li key={ticket.id}>
                <Card className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <p className="text-fg-0 text-sm font-medium">{ticket.subject}</p>
                    <p className="text-fg-2 text-xs">
                      {ticket.category} · {new Date(ticket.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge tone={ticket.status === "resolved" || ticket.status === "closed" ? "accepted" : "info"}>
                    {STATUS_LABEL[ticket.status] ?? ticket.status}
                  </Badge>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
