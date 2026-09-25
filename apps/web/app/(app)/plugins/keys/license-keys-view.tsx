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
  PageHeader,
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
export function LicenseKeysView({
  embedded = false,
}: {
  /**
   * `true` when the list sits inside another page (`/plugins-app`): the
   * heading drops to an `h2` so that page keeps its single title, and the
   * "New key" button is secondary so it does not compete with that page's
   * own actions. `/plugins/keys` renders it standalone with a `PageHeader`.
   */
  readonly embedded?: boolean;
} = {}): React.JSX.Element {
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

  const description =
    "Offline activation for plugins and the desktop app. A key keeps working for 7 days without a connection.";

  const createDialog = isAdmin ? (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogTrigger asChild>
        <Button
          variant={embedded ? "secondary" : "primary"}
          data-testid="create-license-key-button"
        >
          New key
        </Button>
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
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending}
              data-testid="submit-create-key"
            >
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  ) : undefined;

  return (
    <section
      className={
        embedded ? "flex w-full flex-col gap-4" : "mx-auto flex w-full max-w-4xl flex-col gap-8"
      }
      data-testid="license-keys-page"
    >
      {embedded ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-fg-0 text-lg font-semibold">Licence keys</h2>
            <p className="text-fg-2 text-sm">{description}</p>
          </div>
          {createDialog}
        </div>
      ) : (
        <PageHeader title="Licence keys" description={description} actions={createDialog} />
      )}

      {justCreated !== null ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="text-fg-2 text-xs">
              New licence key. Copy it now: it is shown only once.
            </p>
            <p className="text-fg-0 font-mono text-sm tracking-wide" data-testid="just-created-key">
              {justCreated}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void copyKey(justCreated)}>
            Copy key
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
            className="border-0"
            icon={<KeyRound />}
            title="No licence keys yet"
            description={
              isAdmin
                ? "Create one for a machine that edits offline."
                : "A workspace admin can create one for a machine that edits offline."
            }
          />
        ) : (
          <ul className="divide-border divide-y" data-testid="license-key-list">
            {(keys.data ?? []).map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-4 p-4"
                data-testid={`key-${key.id}`}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-fg-0 flex flex-wrap items-center gap-2 text-sm font-medium">
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
                    aria-label={`Revoke ${key.label ?? "untitled key"}`}
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
