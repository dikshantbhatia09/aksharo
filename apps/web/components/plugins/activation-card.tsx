"use client";

import Link from "next/link";
import * as React from "react";

import type { DeviceView, PluginManifestChannel } from "@montaj/api-client";
import { useRevokeDevice } from "@montaj/api-client";
import { Badge, Button, Card, toast } from "@montaj/ui";

import {
  ACTIVATION_STATE_LABEL,
  channelUnavailable,
  type PluginActivationState,
} from "./plugin-status";

import { messageForError } from "@/lib/errors";

const STATE_TONE: Record<PluginActivationState, "accent" | "neutral" | "warning"> = {
  signed_in: "accent",
  not_installed: "neutral",
  limit_reached: "warning",
};

export interface ActivationChannel {
  readonly key: string;
  /** e.g. "Adobe Premiere Pro" -- the host this channel installs into. */
  readonly hostLabel: string;
  readonly manifest: PluginManifestChannel | undefined;
}

export interface CapabilityNote {
  readonly label: string;
  readonly note: string;
}

/**
 * The activation card v2 (08 §4 "Plugins page (web) -- the activation card
 * (v2)"): three steps (Install, Connect, Caption your timeline), version and
 * minimum-host-version per channel, a tutorials link, the device list for
 * this product with revoke, and honest capability notes. One card per
 * product name (D65): Adobe panel (Premiere + After Effects) and the
 * DaVinci Resolve script are two separate cards because they are two
 * separate product names, even though both read the same `devices` list.
 */
export function ActivationCard({
  title,
  captionCopy,
  channels,
  devices,
  state,
  activeCount,
  limit,
  tutorialsHref,
  capabilityNotes,
  upgradeSlot,
  testId,
}: {
  readonly title: string;
  /** Step 3 copy, e.g. `your transcript appears in Text-Based Editing`. */
  readonly captionCopy: string;
  readonly channels: readonly ActivationChannel[];
  readonly devices: readonly DeviceView[];
  readonly state: PluginActivationState;
  readonly activeCount: number;
  readonly limit: number;
  readonly tutorialsHref: string;
  readonly capabilityNotes: readonly CapabilityNote[];
  /** Rendered only while `state === "limit_reached"` -- the upgrade gate. */
  readonly upgradeSlot?: React.ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  const revoke = useRevokeDevice();

  return (
    <Card className="flex flex-col gap-5" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-fg-0 font-display text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-fg-2 text-sm">
            {activeCount} / {limit} device{limit === 1 ? "" : "s"} on this plan
          </p>
        </div>
        <Badge tone={STATE_TONE[state]} data-testid={`${testId}-state`}>
          {ACTIVATION_STATE_LABEL[state]}
        </Badge>
      </div>

      {state === "limit_reached" ? upgradeSlot : null}

      <ol className="flex flex-col gap-3 text-sm">
        <Step index={1} title="Install">
          <ul className="flex flex-col gap-1">
            {channels.map((channel) => (
              <li key={channel.key} className="flex items-center justify-between gap-3">
                <span className="text-fg-1">{channel.hostLabel}</span>
                {channelUnavailable(channel.manifest) ? (
                  <span
                    className="text-fg-2 text-xs"
                    data-testid={`${testId}-${channel.key}-unavailable`}
                  >
                    Download coming soon
                  </span>
                ) : (
                  <a
                    className="text-lime-500 rounded-sm text-xs hover:underline"
                    href={channel.manifest?.downloadUrl ?? "#"}
                  >
                    Download
                    {channel.manifest?.version !== null && channel.manifest?.version !== undefined
                      ? ` v${channel.manifest.version}`
                      : ""}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Step>
        <Step index={2} title="Connect">
          <p className="text-fg-2">
            Open the panel and click <strong className="text-fg-0">Sign in</strong> — approve the
            code at{" "}
            <Link href="/device" className="text-lime-500 rounded-sm hover:underline">
              Connect a device
            </Link>
            . On an offline machine,{" "}
            <Link href="/plugins/keys" className="text-lime-500 rounded-sm hover:underline">
              generate a licence key
            </Link>{" "}
            instead — it verifies for 7 days without a connection.
          </p>
        </Step>
        <Step index={3} title="Caption your timeline">
          <p className="text-fg-2">{captionCopy}</p>
        </Step>
      </ol>

      <div className="flex flex-col gap-2">
        <h3 className="text-fg-0 text-sm font-medium">Devices</h3>
        {devices.length === 0 ? (
          <p className="text-fg-2 text-sm">No device signed in yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid={`${testId}-devices`}>
            {devices.map((device) => (
              <li key={device.id}>
                <div className="border-border flex items-center justify-between gap-4 rounded-sm border p-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-fg-0 truncate text-sm font-medium">{device.name}</p>
                    <p className="text-fg-2 text-xs">
                      {device.lastActiveAt !== null
                        ? `Last heartbeat ${new Date(device.lastActiveAt).toLocaleString()}`
                        : "No heartbeat yet"}
                      {device.leaseUntil !== null
                        ? ` · lease until ${new Date(device.leaseUntil).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      data-testid={`${testId}-signout-${device.id}`}
                      onClick={() => {
                        revoke.mutate(device.id, {
                          onError: (error) =>
                            toast.error("Could not sign out that device", {
                              description: messageForError(error),
                            }),
                        });
                      }}
                    >
                      Sign out this device
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      data-testid={`${testId}-revoke-${device.id}`}
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
        <Link href={tutorialsHref} className="text-lime-500 rounded-sm hover:underline">
          Browse tutorials
        </Link>
        <ul className="text-fg-2 flex flex-col gap-1">
          {capabilityNotes.map((entry) => (
            <li key={entry.label}>
              <span className="text-fg-1 font-medium">{entry.label}:</span> {entry.note}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function Step({
  index,
  title,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span className="bg-bg-2 text-fg-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
        {index}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-fg-0 font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}
