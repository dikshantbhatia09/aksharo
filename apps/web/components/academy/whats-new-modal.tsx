"use client";

import Link from "next/link";
import * as React from "react";

import { useDismissChangelogVersion, useDismissedChangelogVersion } from "@montaj/api-client";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@montaj/ui";

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
 */
export function WhatsNewModal(): React.JSX.Element | null {
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
    if (latest === null || latest.version === null) return;
    if (dismissed.data === undefined) return;
    if (dismissed.data.dismissedVersion === latest.version) return;
    openedRef.current = true;
    setOpen(true);
  }, [latest, dismissed.data]);

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
