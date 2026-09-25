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

import { INLINE_LINK_CLASS } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

// A state, so a signal hue with its word; never the brand accent.
const STATE_TONE: Record<PluginActivationState, "accepted" | "neutral" | "warning"> = {
  signed_in: "accepted",
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
          <h2 className="text-fg-0 text-lg font-semibold">{title}</h2>
          <p className="text-fg-2 text-sm">
            {activeCount} / {limit} device{limit === 1 ? "" : "s"} on this plan
          </p>
        </div>
        {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
        <Badge tone={STATE_TONE[state]} data-testid={`${testId}-state`}>
          {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
          {ACTIVATION_STATE_LABEL[state]}
        </Badge>
      </div>

      {state === "limit_reached" ? upgradeSlot : null}

      <ol className="flex flex-col gap-3 text-sm">
        <Step index={1} title="Install">
          <ul className="flex flex-col gap-1">
            {channels.map((channel) => (
              <li key={channel.key} className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-fg-1">{channel.hostLabel}</span>
                {channelUnavailable(channel.manifest) ? (
                  <span
                    className="text-fg-2 text-xs"
                    data-testid={`${testId}-${channel.key}-unavailable`}
                  >
                    Download coming soon
                  </span>
                ) : (
                  <Button variant="secondary" size="sm" asChild>
                    <a href={channel.manifest?.downloadUrl ?? "#"}>
                      Download for {channel.hostLabel}
                      {channel.manifest?.version !== null && channel.manifest?.version !== undefined
                        ? ` (v${channel.manifest.version})`
                        : ""}
                    </a>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Step>
        <Step index={2} title="Connect">
          <p className="text-fg-2">
            Open the panel and click <strong className="text-fg-0">Sign in</strong> — approve the
            code at{" "}
            <Link href="/device" className={INLINE_LINK_CLASS}>
              Connect a device
            </Link>
            . On an offline machine,{" "}
            <Link href="/plugins/keys" className={INLINE_LINK_CLASS}>
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
        <h3 className="text-fg-0 text-sm font-semibold">Devices</h3>
        {devices.length === 0 ? (
          <p className="text-fg-2 text-sm">
            No device signed in yet. Sign in from the panel (step 2) and it appears here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid={`${testId}-devices`}>
            {devices.map((device) => (
              <li key={device.id}>
                <div className="border-border flex flex-wrap items-center justify-between gap-4 rounded-sm border p-3">
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
                      variant="secondary"
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
        <Link href={tutorialsHref} className={INLINE_LINK_CLASS}>
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
      <span className="border-border text-fg-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums">
        {index}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-fg-0 font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}
