"use client";

/**
 * Owner-side share-link management (B15 brief §1): create a link (scope,
 * optional password, expiry, view cap), list a project's links with their
 * live state, and revoke one. A standalone panel — not yet wired into the
 * editor's own right-hand panel switcher (`RightPanel.tsx` is a purpose-built
 * style panel with no generic tab slot; adding one is outside this work
 * package's `apps/web/components/{review,batch,imports}/**` boundary) — ready
 * to be mounted wherever a "Share" entry point lands.
 */

import { Lock } from "lucide-react";
import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Badge, Button, ConfirmAction, Field, Input } from "@montaj/ui";

import type { ShareLinkScope } from "@/lib/share/types";

import { useCreateShareLink, useProjectShareLinks, useRevokeShareLink } from "@/lib/share/hooks";

const SCOPES: readonly { value: ShareLinkScope; label: string }[] = [
  { value: "view", label: "View only" },
  { value: "comment", label: "View and comment" },
  { value: "approve", label: "View, comment and approve" },
];

/** The scope's words, never its enum value. */
function scopeLabel(scope: ShareLinkScope): string {
  return SCOPES.find((option) => option.value === scope)?.label ?? scope;
}

const FIELD_CONTROL = "h-9 w-full rounded-sm border border-border bg-sunken px-3 text-sm text-fg-0";

function statusOf(link: {
  readonly revokedAt: string | null;
  readonly autoDisabled: boolean;
  readonly expiresAt: string | null;
}): { readonly label: string; readonly tone: "accepted" | "neutral" | "rejected" } {
  if (link.autoDisabled) return { label: "Auto-disabled", tone: "rejected" };
  if (link.revokedAt !== null) return { label: "Revoked", tone: "neutral" };
  if (link.expiresAt !== null && new Date(link.expiresAt).getTime() < Date.now()) {
    return { label: "Expired", tone: "neutral" };
  }
  // A live link is a status signal, not brand decoration: the accepted hue,
  // with the word carrying the meaning.
  return { label: "Live", tone: "accepted" };
}

export function ShareLinksPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const links = useProjectShareLinks(projectId);
  const create = useCreateShareLink(projectId);
  const revoke = useRevokeShareLink(projectId);

  const [scope, setScope] = React.useState<ShareLinkScope>("view");
  const [password, setPassword] = React.useState("");
  const [maxViews, setMaxViews] = React.useState("");
  const [copiedId, setCopiedId] = React.useState<string | undefined>(undefined);

  const copy = async (url: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(undefined), 2000);
    } catch {
      // Clipboard access denied (permissions, insecure context) — the URL is
      // still shown on screen for a manual copy.
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="share-links-panel">
      <form
        className="flex flex-col gap-4 rounded-md border border-border bg-surface p-5"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              scope,
              password: password === "" ? undefined : password,
              maxViews: maxViews === "" ? undefined : Number(maxViews),
            },
            { onSuccess: () => setPassword("") },
          );
        }}
      >
        <h3 className="text-base text-fg-0">Create a review link</h3>
        <Field label="Who can do what" htmlFor="share-create-scope">
          <select
            id="share-create-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as ShareLinkScope)}
            className={FIELD_CONTROL}
            data-testid="share-create-scope"
          >
            {SCOPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password (optional)" htmlFor="share-create-password">
            <Input
              id="share-create-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="bg-sunken"
              data-testid="share-create-password"
            />
          </Field>
          <Field label="View limit (optional)" htmlFor="share-create-max-views">
            <Input
              id="share-create-max-views"
              type="number"
              min={1}
              value={maxViews}
              onChange={(event) => setMaxViews(event.target.value)}
              className="bg-sunken"
              data-testid="share-create-max-views"
            />
          </Field>
        </div>
        {/* The dialog's one primary action. */}
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending}
          className="self-start"
        >
          {create.isPending ? "Creating…" : "Create link"}
        </Button>
        {create.isError ? (
          <p role="alert" className="text-sm text-rejected">
            {isApiError(create.error)
              ? create.error.message
              : "The link could not be created. Check your connection and try again."}
          </p>
        ) : null}
      </form>

      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="share-links-list">
        {(links.data ?? []).map((link) => {
          const status = statusOf(link);
          return (
            <li
              key={link.id}
              className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 text-sm"
              data-testid="share-link-item"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="text-xs text-fg-2">{scopeLabel(link.scope)}</span>
                  {link.hasPassword ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                      <Lock className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Password
                    </span>
                  ) : null}
                </div>
                <span className="text-xs text-fg-2 tabular-nums">
                  {link.viewCount} view{link.viewCount === 1 ? "" : "s"}
                  {link.maxViews === null ? "" : ` / ${String(link.maxViews)}`}
                </span>
              </div>
              <code className="truncate rounded-sm bg-sunken px-2 py-1.5 font-mono text-xs text-fg-1">
                {link.url}
              </code>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void copy(link.url, link.id)}
                >
                  {copiedId === link.id ? "Copied" : "Copy link"}
                </Button>
                {status.label === "Live" ? (
                  <ConfirmAction
                    title="Revoke this share link?"
                    description="Anyone who opens it sees that it has been revoked. You can make a new link, but it will have a different address."
                    confirmLabel="Revoke link"
                    confirmTestId={`confirm-revoke-link-${link.id}`}
                    onConfirm={() => revoke.mutate(link.id)}
                    trigger={
                      <Button type="button" size="sm" variant="ghost" disabled={revoke.isPending}>
                        Revoke
                      </Button>
                    }
                  />
                ) : null}
              </div>
              {link.reportCount > 0 ? (
                <p className="text-xs text-fg-2" data-testid="share-link-report-count">
                  {link.reportCount} report{link.reportCount === 1 ? "" : "s"}
                </p>
              ) : null}
            </li>
          );
        })}
        {links.data !== undefined && links.data.length === 0 ? (
          <li className="text-sm text-fg-2">
            No review links yet. Create one above to send this project for review.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
