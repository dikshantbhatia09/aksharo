"use client";

import { MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  useDevices,
  useRenameDevice,
  useRevokeDevice,
  useRevokeSession,
  useSessions,
} from "@montaj/api-client";
import type { DeviceView as RegisteredDevice, SessionSummary } from "@montaj/api-client";
import { Badge, Button, Card, EmptyState, Input, Skeleton, toast } from "@montaj/ui";

import { SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

/**
 * Devices & sessions (08 §Settings, THREAT-MODEL T2).
 *
 * Every live refresh-token family, with the one you are using marked, and a
 * revoke button per row. This is the control a user reaches for after losing a
 * laptop, so the current session is clearly labelled and cannot be revoked by
 * accident — signing yourself out is a different button, in the profile menu.
 */
export function DevicesView(): React.JSX.Element {
  const sessions = useSessions();
  const revoke = useRevokeSession();

  return (
    <SettingsSection
      title="Devices & sessions"
      description="Everywhere you are signed in. Revoking a session signs that device out straight away."
      testId="settings-devices"
    >
      {sessions.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : sessions.isError ? (
        <p className="text-rejected text-sm" role="alert">
          {messageForError(sessions.error)}
        </p>
      ) : (sessions.data ?? []).length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone />}
          title="No other sessions"
          description="You are only signed in here."
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="session-list">
          {(sessions.data ?? []).map((session) => (
            <li key={session.id}>
              <Card className="flex items-start justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-fg-0 flex items-center gap-2 text-sm font-medium">
                    {kindLabel(session.kind)}
                    {session.current ? <Badge tone="accent">This device</Badge> : null}
                  </p>
                  <p className="text-fg-2 truncate text-xs">{describeSession(session)}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  data-testid={`revoke-${session.id}`}
                  onClick={() => {
                    revoke.mutate(session.id, {
                      onError: (error) => {
                        toast.error("Could not revoke that session", {
                          description: messageForError(error),
                        });
                      },
                    });
                  }}
                >
                  {session.current ? "Sign out here" : "Revoke"}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-medium">Connecting a plugin or the desktop app</h2>
        <p className="text-fg-2 text-sm">
          The app shows a code; you approve it here. Start at{" "}
          <Link href="/device" className="text-lime-500 rounded-sm hover:underline">
            Connect a device
          </Link>
          . We will never ask you for that code over the phone or by email.
        </p>
      </Card>

      <RegisteredDevicesSection />
    </SettingsSection>
  );
}

const KIND_LABEL: Record<string, string> = {
  web: "Browser",
  desktop: "Desktop app",
  bridge: "Local bridge",
  premiere: "Adobe Premiere Pro panel",
  ae: "Adobe After Effects panel",
  resolve: "DaVinci Resolve script",
  api: "API key",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** "Chrome on Windows · 203.0.113.10 · started 2 Sep" — never the token. */
export function describeSession(session: SessionSummary): string {
  const parts = [shortUserAgent(session.ua), session.ip ?? "unknown address"];
  const started = new Date(session.createdAt);
  if (!Number.isNaN(started.getTime())) {
    parts.push(
      `started ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(started)}`,
    );
  }
  return parts.filter((part) => part !== "").join(" · ");
}

/** A user agent is attacker-controlled, so only a known shape is rendered. */
export function shortUserAgent(ua: string | null): string {
  if (ua === null || ua === "") return "Unknown device";
  const browser = /(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(ua)?.[1];
  const platform = /(Windows|Macintosh|Linux|Android|iPhone|iPad)/.exec(ua)?.[1];
  const browserName = browser === "Edg" ? "Edge" : browser;
  const platformName = platform === "Macintosh" ? "macOS" : platform;
  if (browserName === undefined && platformName === undefined) return "Unknown device";
  return [browserName, platformName].filter((part) => part !== undefined).join(" on ");
}

/**
 * Registered devices (B08): the `devices` row per plugin/desktop
 * installation, distinct from the auth session list above — a session is a
 * login; a device is the machine a licence key or a plugin sign-in counted
 * against the plan's device limit. Rename and revoke; revoking here fails the
 * device's next heartbeat (THREAT-MODEL T15).
 */
function RegisteredDevicesSection(): React.JSX.Element {
  const devices = useDevices();
  const rename = useRenameDevice();
  const revoke = useRevokeDevice();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState("");

  const active = (devices.data ?? []).filter((d) => d.revokedAt === null);

  return (
    <div className="flex flex-col gap-2" data-testid="registered-devices">
      <h2 className="text-fg-0 text-base font-medium">Devices</h2>
      <p className="text-fg-2 text-sm">
        Plugins and the desktop app, counted against your plan&apos;s device limit.
      </p>
      {devices.isPending ? (
        <Skeleton className="h-16" />
      ) : devices.isError ? (
        <p className="text-rejected text-sm" role="alert">
          {messageForError(devices.error)}
        </p>
      ) : active.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone />}
          title="No registered devices"
          description="A plugin or the desktop app will appear here once you sign in."
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="device-list">
          {active.map((device: RegisteredDevice) => (
            <li key={device.id}>
              <Card className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  {editingId === device.id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        rename.mutate(
                          { deviceId: device.id, name: editingName.trim() || device.name },
                          { onSettled: () => setEditingId(null) },
                        );
                      }}
                    >
                      <Input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="h-8 text-sm"
                      />
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                    </form>
                  ) : (
                    <p className="text-fg-0 flex items-center gap-2 text-sm font-medium">
                      {device.name}
                      {device.isCurrentSession ? <Badge tone="accent">This device</Badge> : null}
                    </p>
                  )}
                  <p className="text-fg-2 truncate text-xs">
                    {device.platform}
                    {device.leaseUntil !== null
                      ? ` · lease until ${new Date(device.leaseUntil).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {editingId !== device.id ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingId(device.id);
                        setEditingName(device.name);
                      }}
                    >
                      Rename
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    data-testid={`revoke-device-${device.id}`}
                    onClick={() => {
                      revoke.mutate(device.id, {
                        onError: (error) =>
                          toast.error("Could not revoke that device", {
                            description: messageForError(error),
                          }),
                      });
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
