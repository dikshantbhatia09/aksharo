"use client";

import { KeyRound, RefreshCw, Trash2, Webhook } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  API_KEY_SCOPES,
  useApiKeys,
  useCreateApiKey,
  useCreateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useRedeliverWebhookDelivery,
  useRevokeApiKey,
  useRotateApiKey,
  useSendWebhookTestEvent,
  useWebhookDeliveries,
  useWebhookEndpoints,
  WEBHOOK_EVENT_NAMES,
} from "@montaj/api-client";
import type { ApiKeyScope, MintedApiKeyView, WebhookEventName } from "@montaj/api-client";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  toast,
} from "@montaj/ui";

import { SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  projects_read: "Read projects",
  projects_write: "Create projects, start transcription",
  transcripts_read: "Read transcripts",
  exports_write: "Request exports",
  webhooks_manage: "Manage webhooks",
};

const EVENT_LABEL: Record<WebhookEventName, string> = {
  "transcript.completed": "Transcript completed",
  "export.completed": "Export completed",
  "job.failed": "Job failed",
  "credits.low": "Credits low",
};

/**
 * Settings → Developers (B14 §5): API keys and webhooks.
 *
 * A minted key or a webhook secret is shown exactly once — on the response of
 * the call that created or rotated it — and never again, matching what the API
 * itself does (`api_keys.hash` is one-way). Copy it now or lose it.
 */
export function DevelopersView(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      <SettingsSection
        title="Developers"
        description="API keys for the public API, available on Studio and Agency."
        testId="settings-developers"
      >
        <p className="text-fg-2 -mt-2 text-sm">
          See the{" "}
          <Link href="/developers" className="text-lime-500 underline" target="_blank">
            API docs
          </Link>{" "}
          for endpoints, scopes and quick-starts in curl, Node and Python.
        </p>
        <ApiKeysCard />
      </SettingsSection>

      <SettingsSection
        title="Webhooks"
        description="Get notified the moment a transcript finishes, an export completes, a job fails, or credits run low."
        testId="settings-webhooks"
      >
        <WebhooksCard />
      </SettingsSection>
    </div>
  );
}

// -----------------------------------------------------------------------------
// API keys
// -----------------------------------------------------------------------------

function ApiKeysCard(): React.JSX.Element {
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const rotate = useRotateApiKey();
  const revoke = useRevokeApiKey();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [minted, setMinted] = React.useState<MintedApiKeyView | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="create-api-key">
          New API key
        </Button>
      </div>

      {keys.isPending ? (
        <Skeleton className="h-16" />
      ) : keys.isError ? (
        <p className="text-rejected text-sm" role="alert">
          {messageForError(keys.error)}
        </p>
      ) : (keys.data ?? []).length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No API keys yet"
          description="Mint one to call the public API from a script or an integration."
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="api-key-list">
          {(keys.data ?? []).map((key) => (
            <li key={key.id}>
              <Card className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-fg-0 flex items-center gap-2 text-sm font-medium">
                    {key.name || key.prefix}
                    {key.revokedAt !== null ? <Badge tone="rejected">Revoked</Badge> : null}
                  </p>
                  <p className="text-fg-2 truncate text-xs">
                    {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
                    {key.prefix}.… · {key.scopes.map((s) => SCOPE_LABEL[s]).join(", ")}
                    {key.expiresAt !== null
                      ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                {key.revokedAt === null ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rotate.isPending}
                      data-testid={`rotate-${key.id}`}
                      onClick={() => {
                        rotate.mutate(key.id, {
                          onSuccess: (result) => setMinted(result),
                          onError: (error) =>
                            toast.error("Could not rotate that key", {
                              description: messageForError(error),
                            }),
                        });
                      }}
                    >
                      <RefreshCw className="size-4" /> Rotate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      data-testid={`revoke-${key.id}`}
                      onClick={() => {
                        revoke.mutate(key.id, {
                          onError: (error) =>
                            toast.error("Could not revoke that key", {
                              description: messageForError(error),
                            }),
                        });
                      }}
                    >
                      <Trash2 className="size-4" /> Revoke
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setMinted}
        submitting={create.isPending}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (result) => {
              setCreateOpen(false);
              setMinted(result);
            },
            onError: (error) =>
              toast.error("Could not create the key", { description: messageForError(error) }),
          })
        }
      />

      <RevealSecretDialog
        title="Your new API key"
        value={minted?.key ?? null}
        onClose={() => setMinted(null)}
      />
    </div>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (view: MintedApiKeyView) => void;
  submitting: boolean;
  onSubmit: (input: { name: string; scopes: ApiKeyScope[] }) => void;
}): React.JSX.Element {
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiKeyScope[]>([]);

  React.useEffect(() => {
    if (!open) {
      setName("");
      setScopes([]);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>Pick only the scopes this key needs.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="api-key-name" hint="So you recognise it later.">
            <Input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CI pipeline"
              data-testid="api-key-name"
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-fg-1 text-sm font-medium">Scopes</legend>
            {API_KEY_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={scopes.includes(scope)}
                  onCheckedChange={(checked) =>
                    setScopes((current) =>
                      checked === true
                        ? [...current, scope]
                        : current.filter((entry) => entry !== scope),
                    )
                  }
                  data-testid={`scope-${scope}`}
                />
                {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
                <span className="text-fg-0">{SCOPE_LABEL[scope]}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={name.trim() === "" || scopes.length === 0 || submitting}
            data-testid="submit-create-api-key"
            onClick={() => onSubmit({ name: name.trim(), scopes })}
          >
            Create key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Webhooks
// -----------------------------------------------------------------------------

function WebhooksCard(): React.JSX.Element {
  const endpoints = useWebhookEndpoints();
  const remove = useDeleteWebhookEndpoint();
  const test = useSendWebhookTestEvent();
  const create = useCreateWebhookEndpoint();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [logEndpointId, setLogEndpointId] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="create-webhook">
          New webhook
        </Button>
      </div>

      {endpoints.isPending ? (
        <Skeleton className="h-16" />
      ) : endpoints.isError ? (
        <p className="text-rejected text-sm" role="alert">
          {messageForError(endpoints.error)}
        </p>
      ) : (endpoints.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Webhook />}
          title="No webhooks yet"
          description="Get an HTTPS POST the moment something happens."
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="webhook-list">
          {(endpoints.data ?? []).map((endpoint) => (
            <li key={endpoint.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-fg-0 truncate text-sm font-medium">{endpoint.url}</p>
                    <p className="text-fg-2 truncate text-xs">
                      {endpoint.events.join(", ")}
                      {!endpoint.active ? " · disabled" : ""}
                      {endpoint.failures > 0
                        ? ` · ${String(endpoint.failures)} consecutive failures`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={test.isPending}
                      data-testid={`test-${endpoint.id}`}
                      onClick={() => {
                        test.mutate(endpoint.id, {
                          onSuccess: () => toast.success("Test event sent"),
                          onError: (error) =>
                            toast.error("Could not send a test event", {
                              description: messageForError(error),
                            }),
                        });
                      }}
                    >
                      Send test event
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setLogEndpointId(logEndpointId === endpoint.id ? null : endpoint.id)
                      }
                    >
                      {logEndpointId === endpoint.id ? "Hide log" : "Delivery log"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending}
                      data-testid={`delete-${endpoint.id}`}
                      onClick={() => remove.mutate(endpoint.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {logEndpointId === endpoint.id ? <DeliveryLog endpointId={endpoint.id} /> : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <CreateWebhookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={create.isPending}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (result) => {
              setCreateOpen(false);
              setSecret(result.secret);
            },
            onError: (error) =>
              toast.error("Could not create the webhook", { description: messageForError(error) }),
          })
        }
      />

      <RevealSecretDialog
        title="Your webhook signing secret"
        value={secret}
        onClose={() => setSecret(null)}
      />
    </div>
  );
}

function DeliveryLog({ endpointId }: { endpointId: string }): React.JSX.Element {
  const deliveries = useWebhookDeliveries(endpointId);
  const redeliver = useRedeliverWebhookDelivery();

  if (deliveries.isPending) return <Skeleton className="h-10" />;
  if (deliveries.isError) {
    return (
      <p className="text-rejected text-xs" role="alert">
        {messageForError(deliveries.error)}
      </p>
    );
  }
  const rows = deliveries.data ?? [];
  if (rows.length === 0) return <p className="text-fg-2 text-xs">No deliveries yet.</p>;

  return (
    <ul
      className="border-border flex flex-col gap-1 border-t pt-2 text-xs"
      data-testid={`deliveries-${endpointId}`}
    >
      {rows.map((delivery) => (
        <li key={delivery.id} className="flex items-center justify-between gap-2">
          <span className="text-fg-1">
            {delivery.event} · {delivery.status}
            {delivery.responseCode !== null ? ` (${String(delivery.responseCode)})` : ""} ·{" "}
            {new Date(delivery.createdAt).toLocaleString()}
          </span>
          {delivery.status === "dead" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={redeliver.isPending}
              onClick={() => redeliver.mutate(delivery.id)}
            >
              Redeliver
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (input: { url: string; events: WebhookEventName[] }) => void;
}): React.JSX.Element {
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<WebhookEventName[]>([]);

  React.useEffect(() => {
    if (!open) {
      setUrl("");
      setEvents([]);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New webhook</DialogTitle>
          <DialogDescription>An HTTPS URL that can receive a signed POST.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="URL" htmlFor="webhook-url">
            <Input
              id="webhook-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/hooks/aksharo"
              data-testid="webhook-url"
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-fg-1 text-sm font-medium">Events</legend>
            {WEBHOOK_EVENT_NAMES.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={events.includes(event)}
                  onCheckedChange={(checked) =>
                    setEvents((current) =>
                      checked === true
                        ? [...current, event]
                        : current.filter((entry) => entry !== event),
                    )
                  }
                  data-testid={`event-${event}`}
                />
                {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
                <span className="text-fg-0">{EVENT_LABEL[event]}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={url.trim() === "" || events.length === 0 || submitting}
            data-testid="submit-create-webhook"
            onClick={() => onSubmit({ url: url.trim(), events })}
          >
            Create webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Shared: reveal-once secret dialog
// -----------------------------------------------------------------------------

function RevealSecretDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={value !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy it now — this is the only time it is shown. If you lose it, rotate or recreate.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-bg-2 rounded-sm p-3">
          <code className="text-fg-0 block overflow-x-auto text-xs" data-testid="revealed-secret">
            {value}
          </code>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              if (value !== null) void navigator.clipboard.writeText(value);
              toast.success("Copied");
            }}
          >
            Copy
          </Button>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
