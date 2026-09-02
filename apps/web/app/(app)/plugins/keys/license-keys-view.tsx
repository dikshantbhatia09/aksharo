"use client";

import { KeyRound } from "lucide-react";
import * as React from "react";

import {
  useCreateLicenseKey,
  useLicenseKeys,
  useRevokeLicenseKey,
  useSession,
} from "@montaj/api-client";
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
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  toast,
} from "@montaj/ui";

import { messageForError } from "@/lib/errors";

/**
 * Licence keys, under Plugins (brief §3, §4): create, copy, revoke,
 * activations. A key's full value (`AK-XXXX-XXXX-XXXX`) is shown once, right
 * after creation — the API returns it in the create response and never again
 * (`license_keys.key` is stored, but this page does not re-display it on a
 * later `GET`, matching how a password manager or an API-key page treats a
 * secret it can no longer fully show).
 */
export function LicenseKeysView(): React.JSX.Element {
  const session = useSession();
  const keys = useLicenseKeys();
  const create = useCreateLicenseKey();
  const revoke = useRevokeLicenseKey();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [maxActivations, setMaxActivations] = React.useState(1);
  const [justCreated, setJustCreated] = React.useState<string | null>(null);

  const isAdmin = session?.role === "owner" || session?.role === "admin";

  function submitCreate(event: React.FormEvent): void {
    event.preventDefault();
    create.mutate(
      { label: label.trim() === "" ? undefined : label.trim(), maxActivations },
      {
        onSuccess: (key) => {
          setJustCreated(key.key);
          setCreateOpen(false);
          setLabel("");
          setMaxActivations(1);
        },
        onError: (error) =>
          toast.error("Could not create a licence key", { description: messageForError(error) }),
      },
    );
  }

  async function copyKey(key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(key);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy — select and copy the key by hand.");
    }
  }

  return (
    <section
      className="mx-auto flex w-full max-w-4xl flex-col gap-6"
      data-testid="license-keys-page"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Licence keys</h1>
          <p className="text-fg-2 text-sm">
            Offline activation for plugins and the desktop app, verifiable for 7 days without a
            connection.
          </p>
        </div>
        {isAdmin ? (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="create-license-key-button">New key</Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={submitCreate} className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>Create a licence key</DialogTitle>
                  <DialogDescription>
                    Shown in full once — copy it before you close this.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Label (optional)" htmlFor="key-label">
                  <Input
                    id="key-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Editing suite, floor 2"
                  />
                </Field>
                <Field label="Activation limit" htmlFor="key-activations">
                  <Input
                    id="key-activations"
                    type="number"
                    min={1}
                    max={1000}
                    value={maxActivations}
                    onChange={(e) => setMaxActivations(Number(e.target.value) || 1)}
                  />
                </Field>
                <DialogFooter>
                  <Button type="submit" disabled={create.isPending} data-testid="submit-create-key">
                    Create
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {justCreated !== null ? (
        <Card className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-fg-2 text-xs">New licence key — copy it now</p>
            <p className="text-fg-0 font-mono text-sm tracking-wide" data-testid="just-created-key">
              {justCreated}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void copyKey(justCreated)}>
            Copy
          </Button>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-0 p-0" data-testid="license-keys-card">
        {keys.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : keys.isError ? (
          <p className="text-rejected p-4 text-sm" role="alert">
            {messageForError(keys.error)}
          </p>
        ) : (keys.data ?? []).length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title="No licence keys yet"
            description="Create one for offline activation."
          />
        ) : (
          <ul className="divide-border divide-y" data-testid="license-key-list">
            {(keys.data ?? []).map((key) => (
              <li
                key={key.id}
                className="flex items-center justify-between gap-4 p-4"
                data-testid={`key-${key.id}`}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-fg-0 flex items-center gap-2 text-sm font-medium">
                    {key.label ?? "Untitled"}
                    {key.revokedAt !== null ? <Badge tone="rejected">Revoked</Badge> : null}
                  </p>
                  <p className="text-fg-2 text-xs">
                    {key.activationCount} / {key.maxActivations} activation
                    {key.maxActivations === 1 ? "" : "s"}
                    {key.offlineUntil !== null
                      ? ` · offline until ${new Date(key.offlineUntil).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                {isAdmin && key.revokedAt === null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    data-testid={`revoke-key-${key.id}`}
                    onClick={() => {
                      revoke.mutate(key.id, {
                        onError: (error) =>
                          toast.error("Could not revoke that key", {
                            description: messageForError(error),
                          }),
                      });
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
