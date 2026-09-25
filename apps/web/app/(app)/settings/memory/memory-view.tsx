"use client";

import { Brain, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  useClearMemory,
  useCreateMemoryEntry,
  useDeleteMemoryEntry,
  useImportMemoryGlossary,
  useMemoryEntries,
  useUpdateMemoryEntry,
} from "@montaj/api-client";
import type { MemoryEntry } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Textarea,
  toast,
} from "@montaj/ui";

import { INLINE_LINK_CLASS, SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";
import { readPrivacy, subscribePrivacy } from "@/lib/privacy/consent";

const KIND_LABEL: Record<string, string> = {
  spelling: "Spelling",
  glossary: "Glossary",
  timingNudge: "Timing nudge",
  stylePref: "Style preference",
};

/**
 * "What {BRAND} learned" (D62).
 *
 * Learned memory is opt-in, so this screen is **disabled until the memory
 * consent exists** and says exactly what would go in it. Entries carry a rolling
 * 12-month expiry and are in the erasure cascade; clearing is one button and
 * takes effect immediately. Every entry can be edited or deleted on its own,
 * and glossary terms can be added one at a time or imported in bulk (CSV:
 * `term` or `term,alias1;alias2` per line).
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
  const [editing, setEditing] = React.useState<MemoryEntry | null>(null);

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
          <h2 className="text-fg-0 text-base font-semibold">Memory is off</h2>
          <p className="text-fg-2 text-sm">
            Nothing is being remembered, so there is nothing to show. Turn on “Remember my spellings
            and preferences” in{" "}
            <Link href="/settings/privacy" className={INLINE_LINK_CLASS}>
              Privacy
            </Link>{" "}
            if you want {BRAND.name} to stop asking you to fix the same name twice.
          </p>
        </Card>
      ) : (
        <>
          <GlossaryImport />

          {entries.isPending ? (
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
                  <MemoryRow
                    key={entry.id}
                    entry={entry}
                    onEdit={() => {
                      setEditing(entry);
                    }}
                  />
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
        </>
      )}

      <EditEntryDialog
        entry={editing}
        onClose={() => {
          setEditing(null);
        }}
      />

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

function MemoryRow({
  entry,
  onEdit,
}: {
  entry: MemoryEntry;
  onEdit: () => void;
}): React.JSX.Element {
  const remove = useDeleteMemoryEntry();
  return (
    <li>
      <Card className="flex items-baseline justify-between gap-4 p-4">
        <div className="min-w-0">
          <p className="text-fg-0 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="neutral">{KIND_LABEL[entry.kind] ?? entry.kind}</Badge>
            <span>
              {entry.key} → {entry.value}
            </span>
            {entry.deviceOnly ? <Badge tone="neutral">This device only</Badge> : null}
          </p>
          {entry.aliases !== undefined && entry.aliases.length > 0 ? (
            <p className="text-fg-2 text-xs">Also heard as: {entry.aliases.join(", ")}</p>
          ) : null}
          <p className="text-fg-2 text-xs">
            Applied {entry.hits} {entry.hits === 1 ? "time" : "times"} · Expires{" "}
            {formatDate(entry.expiresAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${entry.key}`}
            data-testid={`edit-memory-${entry.id}`}
            onClick={onEdit}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete ${entry.key}`}
            disabled={remove.isPending}
            data-testid={`delete-memory-${entry.id}`}
            onClick={() => {
              remove.mutate(entry.id, {
                onError: (error) => {
                  toast.error("Could not delete that", { description: messageForError(error) });
                },
              });
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </Card>
    </li>
  );
}

function EditEntryDialog({
  entry,
  onClose,
}: {
  entry: MemoryEntry | null;
  onClose: () => void;
}): React.JSX.Element {
  const update = useUpdateMemoryEntry();
  const [value, setValue] = React.useState("");

  React.useEffect(() => {
    setValue(entry?.value ?? "");
  }, [entry]);

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {entry?.key}</DialogTitle>
          <DialogDescription>Change what {BRAND.name} corrects this to.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={`Correct ${entry?.key ?? "this entry"} to`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          data-testid="edit-memory-value"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={update.isPending || value.trim() === ""}
            data-testid="edit-memory-save"
            onClick={() => {
              if (entry === null) return;
              update.mutate(
                { id: entry.id, body: { value: value.trim() } },
                {
                  onSuccess: () => {
                    toast.success("Saved");
                    onClose();
                  },
                  onError: (error) => {
                    toast.error("Could not save that", { description: messageForError(error) });
                  },
                },
              );
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual add-one-term + CSV bulk import (brief §1: "bulk import of glossary terms (CSV)"). */
function GlossaryImport(): React.JSX.Element {
  const create = useCreateMemoryEntry();
  const importGlossary = useImportMemoryGlossary();
  const [term, setTerm] = React.useState("");
  const [csv, setCsv] = React.useState("");

  return (
    <Card className="flex flex-col gap-3" data-testid="memory-glossary-import">
      <h2 className="text-fg-0 text-base font-semibold">Add glossary terms</h2>
      <p className="text-fg-2 text-sm">
        Names {BRAND.name} should spell exactly your way — channel names, product names, people.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Glossary term"
          placeholder={`e.g. ${BRAND.name}`}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          data-testid="memory-add-term-input"
        />
        <Button
          variant="secondary"
          disabled={create.isPending || term.trim() === ""}
          data-testid="memory-add-term"
          onClick={() => {
            const value = term.trim();
            create.mutate(
              { kind: "glossary", key: value, value, source: "manual" },
              {
                onSuccess: () => {
                  setTerm("");
                  toast.success("Added");
                },
                onError: (error) => {
                  toast.error("Could not add that term", { description: messageForError(error) });
                },
              },
            );
          }}
        >
          Add term
        </Button>
      </div>

      <details>
        <summary className="text-fg-1 hover:text-fg-0 flex min-h-8 cursor-pointer items-center rounded-sm text-sm">
          Import a list (CSV)
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-fg-2 text-xs">
            One term per line: <code>term</code> or <code>term,alias1;alias2</code>.
          </p>
          <Textarea
            rows={4}
            aria-label="Glossary terms, one per line"
            value={csv}
            onChange={(event) => {
              setCsv(event.target.value);
            }}
            data-testid="memory-import-csv"
          />
          <Button
            variant="secondary"
            className="self-start"
            disabled={importGlossary.isPending || csv.trim() === ""}
            data-testid="memory-import-submit"
            onClick={() => {
              importGlossary.mutate(
                { csv },
                {
                  onSuccess: (result) => {
                    setCsv("");
                    toast.success(
                      `Imported ${String(result.imported)}, updated ${String(result.updated)}`,
                    );
                  },
                  onError: (error) => {
                    toast.error("Could not import that", { description: messageForError(error) });
                  },
                },
              );
            }}
          >
            Import terms
          </Button>
        </div>
      </details>
    </Card>
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
