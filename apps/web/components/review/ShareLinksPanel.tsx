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

import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Badge, Button } from "@montaj/ui";

import type { ShareLinkScope } from "@/lib/share/types";

import {
  useCreateShareLink,
  useProjectShareLinks,
  useRevokeShareLink,
} from "@/lib/share/hooks";

const SCOPES: readonly { value: ShareLinkScope; label: string }[] = [
  { value: "view", label: "View only" },
  { value: "comment", label: "View + comment" },
  { value: "approve", label: "View + comment + approve" },
];

function statusOf(link: {
  readonly revokedAt: string | null;
  readonly autoDisabled: boolean;
  readonly expiresAt: string | null;
}): { readonly label: string; readonly tone: "accent" | "neutral" | "rejected" } {
  if (link.autoDisabled) return { label: "Auto-disabled", tone: "rejected" };
  if (link.revokedAt !== null) return { label: "Revoked", tone: "neutral" };
  if (link.expiresAt !== null && new Date(link.expiresAt).getTime() < Date.now()) {
    return { label: "Expired", tone: "neutral" };
  }
  return { label: "Live", tone: "accent" };
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
      setTimeout(() => setCopiedId(undefined), 2000);
    } catch {
      // Clipboard access denied (permissions, insecure context) — the URL is
      // still shown on screen for a manual copy.
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="share-links-panel">
      <form
        className="border-border bg-bg-1 flex flex-col gap-3 rounded-md border p-3"
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
        <h3 className="text-fg-0 text-sm font-semibold">Create a review link</h3>
        <label className="flex flex-col gap-1 text-xs">
          Who can do what
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as ShareLinkScope)}
            className="border-border bg-bg-0 rounded-md border px-2 py-1"
            data-testid="share-create-scope"
          >
            {SCOPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Password (optional)
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="border-border bg-bg-0 rounded-md border px-2 py-1"
            data-testid="share-create-password"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Max views (optional)
          <input
            type="number"
            min={1}
            value={maxViews}
            onChange={(event) => setMaxViews(event.target.value)}
            className="border-border bg-bg-0 rounded-md border px-2 py-1"
            data-testid="share-create-max-views"
          />
        </label>
        <Button type="submit" size="sm" disabled={create.isPending} className="self-start">
          {create.isPending ? "Creating…" : "Create link"}
        </Button>
        {create.isError ? (
          <p className="text-xs text-red-400">
            {isApiError(create.error) ? create.error.message : "Could not create the link."}
          </p>
        ) : null}
      </form>

      <ul className="flex flex-col gap-2" data-testid="share-links-list">
        {(links.data ?? []).map((link) => {
          const status = statusOf(link);
          return (
            <li
              key={link.id}
              className="border-border bg-bg-1 flex flex-col gap-2 rounded-md border p-3 text-sm"
              data-testid="share-link-item"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={status.tone}>
                    {status.label}
                  </Badge>
                  <span className="text-fg-2 text-xs">{link.scope}</span>
                  {link.hasPassword ? (
                    <span className="text-fg-2 text-xs" title="Password-protected">
                      🔒
                    </span>
                  ) : null}
                </div>
                <span className="text-fg-2 text-xs">
                  {link.viewCount} view{link.viewCount === 1 ? "" : "s"}
                  {link.maxViews === null ? "" : ` / ${String(link.maxViews)}`}
                </span>
              </div>
              <code className="text-fg-1 truncate text-xs">{link.url}</code>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(link.url, link.id)}
                >
                  {copiedId === link.id ? "Copied" : "Copy link"}
                </Button>
                {status.label === "Live" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
              {link.reportCount > 0 ? (
                <p className="text-fg-2 text-xs" data-testid="share-link-report-count">
                  {link.reportCount} report{link.reportCount === 1 ? "" : "s"}
                </p>
              ) : null}
            </li>
          );
        })}
        {links.data !== undefined && links.data.length === 0 ? (
          <p className="text-fg-2 text-xs">No review links yet.</p>
        ) : null}
      </ul>
    </div>
  );
}
