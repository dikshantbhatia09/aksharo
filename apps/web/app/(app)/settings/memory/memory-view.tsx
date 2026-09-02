"use client";

import { Brain } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useClearMemory, useMemoryEntries } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  toast,
} from "@montaj/ui";

import { SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";
import { readPrivacy, subscribePrivacy } from "@/lib/privacy/consent";

/**
 * "What {BRAND} learned" (D62).
 *
 * Learned memory is opt-in, so this screen is **disabled until the memory
 * consent exists** and says exactly what would go in it. Entries carry a rolling
 * 12-month expiry and are in the erasure cascade; clearing is one button and
 * takes effect immediately.
 */
export function MemoryView(): React.JSX.Element {
  const [privacy, setPrivacy] = React.useState(() => readPrivacy());
  React.useEffect(() => {
    setPrivacy(readPrivacy());
    return subscribePrivacy(setPrivacy);
  }, []);

  const entries = useMemoryEntries(privacy.memory);
  const clear = useClearMemory();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <SettingsSection
      title={`What ${BRAND.name} learned`}
      description="Spellings, glossary terms, timing nudges and style preferences we remember for you."
      testId="settings-memory"
    >
      <Card className="flex flex-col gap-2">
        <p className="text-fg-1 text-sm">
          We never train AI models on your footage. {BRAND.name} remembers your spellings and
          preferences on your account — view, edit or clear them any time.
        </p>
        <p className="text-fg-2 text-xs">
          Entries expire twelve months after they were last useful, and they go with your account if
          you delete it.
        </p>
      </Card>

      {!privacy.memory ? (
        <Card className="flex flex-col gap-3" data-testid="memory-disabled">
          <h2 className="text-fg-0 text-base font-medium">Memory is off</h2>
          <p className="text-fg-2 text-sm">
            Nothing is being remembered, so there is nothing to show. Turn on “Remember my spellings
            and preferences” in{" "}
            <Link href="/settings/privacy" className="text-lime-500 rounded-sm hover:underline">
              Privacy
            </Link>{" "}
            if you want {BRAND.name} to stop asking you to fix the same name twice.
          </p>
        </Card>
      ) : entries.isPending ? (
        <Skeleton className="h-32" />
      ) : (entries.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Brain />}
          title="Nothing learned yet"
          description="Fix a spelling in the editor and choose “remember this”, and it will show up here."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2" data-testid="memory-list">
            {(entries.data ?? []).map((entry) => (
              <li key={entry.id}>
                <Card className="flex items-baseline justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="text-fg-0 text-sm">
                      <span className="text-fg-2">{entry.kind}</span> · {entry.key} → {entry.value}
                    </p>
                    <p className="text-fg-2 text-xs">Expires {formatDate(entry.expiresAt)}</p>
                  </div>
                </Card>
              </li>
            ))}
          </ul>

          <Button
            variant="danger"
            className="self-start"
            data-testid="clear-memory"
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            Clear everything
          </Button>
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear what we learned?</DialogTitle>
            <DialogDescription>
              Every spelling, glossary term and preference goes. Your projects are untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmOpen(false);
              }}
            >
              Keep them
            </Button>
            <Button
              variant="danger"
              disabled={clear.isPending}
              data-testid="clear-memory-confirm"
              onClick={() => {
                clear.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmOpen(false);
                    toast.success("Cleared");
                  },
                  onError: (error) => {
                    toast.error("Could not clear that", { description: messageForError(error) });
                  },
                });
              }}
            >
              Clear everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
