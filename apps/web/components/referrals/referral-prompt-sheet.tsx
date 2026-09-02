"use client";

import * as React from "react";

import { useMarkReferralPromptShown, useReferralStats } from "@montaj/api-client";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@montaj/ui";

import { ReferralShareRow } from "./referral-share-row";

/**
 * The give-get in-app sheet (brief §3): "Give 30 credits, get 30 credits",
 * shown once per workspace, right after the workspace's first completed
 * export.
 *
 * Visibility is server-decided — `GET /referrals/me`'s `promptEligible`
 * (`apps/api/src/referrals/referrals.service.ts`) is `true` exactly when
 * this workspace has a succeeded export *and* has never been shown the
 * sheet, so this component never re-derives "first export" itself; it only
 * reflects the flag and marks it shown (`POST /referrals/prompt/shown`) the
 * moment the sheet opens, which is what makes "once per workspace" hold
 * even if the tab is closed without dismissing.
 *
 * **Mount point.** Not wired into a page — B07's Refer & Earn page shell
 * has not landed on `main` yet, and this work package's file boundary is
 * `apps/web/components/referrals/**`. Mount `<ReferralPromptSheet />` once,
 * near the root of the signed-in shell (`apps/web/components/shell/app-shell.tsx`,
 * next to where `AppShell` already renders global providers) so it can open
 * on any authenticated page, not just the export dialog — the sheet is a
 * global growth prompt, not scoped to one screen.
 */
export function ReferralPromptSheet(): React.JSX.Element | null {
  const stats = useReferralStats();
  const markShown = useMarkReferralPromptShown();
  const [open, setOpen] = React.useState(false);
  const markedRef = React.useRef(false);
  // A ref to the mutate function, not the function itself, as the effect's
  // dependency: `useMutation` returns a new object on every render, and
  // `markedRef` already makes the effect body idempotent — the ref just
  // keeps the dependency array honest without re-running on every render.
  const markShownRef = React.useRef(markShown.mutate);
  markShownRef.current = markShown.mutate;

  const eligible = stats.data?.promptEligible === true;
  React.useEffect(() => {
    if (!eligible) return;
    if (markedRef.current) return;
    markedRef.current = true;
    setOpen(true);
    markShownRef.current();
  }, [eligible]);

  if (stats.data === undefined) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" data-testid="referral-prompt-sheet">
        <SheetHeader>
          <SheetTitle>Give 30 credits, get 30 credits</SheetTitle>
          <SheetDescription>
            Share your code. When a friend completes their first export, you both get 30 credits —
            free, and they never expire.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <ReferralShareRow code={stats.data.code} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
