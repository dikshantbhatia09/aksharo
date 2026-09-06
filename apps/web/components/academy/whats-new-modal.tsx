"use client";

import Link from "next/link";
import * as React from "react";

import { useDismissChangelogVersion, useDismissedChangelogVersion } from "@montaj/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@montaj/ui";

interface LatestChangelog {
  readonly version: string | null;
  readonly title: string | null;
  readonly tags: readonly string[];
}

/**
 * The What's-new modal (brief §3): shown once, the first time a user opens
 * the app after a new changelog version ships, gated on a per-user dismissed
 * version stored server-side (`GET/POST /academy/changelog/dismissed`).
 *
 * **Mount point**, same shape as B07b's `ReferralPromptSheet`: not wired
 * into a page — this work package's file boundary is
 * `apps/web/components/{academy,help,support}/**`. Mount `<WhatsNewModal />`
 * once, near the root of the signed-in shell
 * (`apps/web/components/shell/app-shell.tsx`), so it can open regardless of
 * which page loaded first.
 *
 * **Never on a first run.** A brand-new account has no news to catch up on, and
 * the modal lands on top of Home's quick-pick — the one control that account
 * needs (F07-D3). It returns `null` instead, *without* dismissing the version,
 * so the first launch after their first project still gets the news.
 */
export function WhatsNewModal({
  hasProjects = true,
}: {
  readonly hasProjects?: boolean;
} = {}): React.JSX.Element | null {
  const dismissed = useDismissedChangelogVersion();
  const dismiss = useDismissChangelogVersion();
  const [latest, setLatest] = React.useState<LatestChangelog | null>(null);
  const [open, setOpen] = React.useState(false);
  const openedRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/changelog/latest")
      .then((response) => response.json() as Promise<LatestChangelog>)
      .then((data) => {
        if (!cancelled) setLatest(data);
      })
      .catch(() => {
        if (!cancelled) setLatest({ version: null, title: null, tags: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (openedRef.current) return;
    if (!hasProjects) return;
    // Never over an open document. This dialog is modal: its overlay covers the
    // viewport, `body` gets pointer-events:none and the app root goes
    // aria-hidden, so every editor control - the style gallery, the script
    // tabs, the timeline - is dead until it is dismissed. It can also open
    // mid-session, because `hasProjects` flips when the projects query
    // resolves. Same rule the shell already applies to toasts over
    // `/p/{projectId}`, and the same "hold it back without spending the
    // version" shape as the first-run guard above: `openedRef` stays false and
    // nothing is dismissed, so the news still arrives on the next screen.
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/p/")) return;
    if (latest === null || latest.version === null) return;
    if (dismissed.data === undefined) return;
    if (dismissed.data.dismissedVersion === latest.version) return;
    openedRef.current = true;
    setOpen(true);
  }, [latest, dismissed.data, hasProjects]);

  if (!hasProjects) return null;
  if (latest === null || latest.version === null) return null;

  function handleClose(): void {
    setOpen(false);
    if (latest?.version !== null && latest?.version !== undefined) {
      dismiss.mutate(latest.version);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent data-testid="whats-new-modal">
        <DialogHeader>
          <DialogTitle>What&apos;s new{latest.title ? `: ${latest.title}` : ""}</DialogTitle>
          <DialogDescription>Version {latest.version}</DialogDescription>
        </DialogHeader>
        {latest.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-2 text-xs">
            {latest.tags.map((tag) => (
              <li key={tag} className="bg-bg-2 text-fg-2 rounded-full px-2 py-0.5">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link href="/updates" onClick={handleClose}>
              See full changelog
            </Link>
          </Button>
          <Button onClick={handleClose}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
