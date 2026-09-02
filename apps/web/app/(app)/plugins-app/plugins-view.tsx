"use client";

import * as React from "react";

import { useDevices, useEntitlement, usePluginManifest } from "@montaj/api-client";
import { Skeleton } from "@montaj/ui";

import { LicenseKeysView } from "../plugins/keys/license-keys-view";

import type { PlanKey } from "@/lib/billing/types";

import { BillingUpgradeGate } from "@/components/billing/billing-upgrade-gate";
import { ActivationCard, type CapabilityNote } from "@/components/plugins/activation-card";
import {
  ADOBE_HOSTS,
  RESOLVE_HOSTS,
  activationStateFor,
  activeDevicesForHosts,
  isDeviceLimitReached,
} from "@/components/plugins/plugin-status";
import { messageForError } from "@/lib/errors";

/** The plan one step up from the workspace's current one, for the upgrade link. */
function nextPlanFor(planKey: PlanKey): PlanKey {
  const order: readonly PlanKey[] = ["free", "starter", "creator", "studio", "agency"];
  const index = order.indexOf(planKey);
  return order[Math.min(index + 1, order.length - 1)] ?? "creator";
}

const ADOBE_CAPABILITY_NOTES: readonly CapabilityNote[] = [
  { label: "Premiere native captions track", note: "waiting on Adobe" },
];
const RESOLVE_CAPABILITY_NOTES: readonly CapabilityNote[] = [
  { label: "Undo", note: "not supported by Resolve's own API" },
];

/**
 * The Plugins page (08 §4 "Plugins page (web) -- the activation card (v2)"):
 * one activation card per product name (D65 "Aksharo Panel -- works with
 * Adobe Premiere Pro and Adobe After Effects" and "Aksharo -- works with
 * DaVinci Resolve"), each with its own three-step Install/Connect/Caption
 * flow, device list, activation-limit state with an upgrade link, and
 * honest capability notes -- plus licence-key management (B08) merged into
 * the same page (brief §2), since a licence key and a device-code sign-in
 * are the two ways the same activation card gets a device onto the plan.
 */
export function PluginsView(): React.JSX.Element {
  const devices = useDevices();
  const entitlement = useEntitlement();
  const manifest = usePluginManifest();

  if (devices.isPending || entitlement.isPending) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="plugins-page">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </section>
    );
  }

  if (devices.isError || entitlement.isError) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="plugins-page">
        <p className="text-rejected text-sm" role="alert">
          {messageForError(devices.error ?? entitlement.error)}
        </p>
      </section>
    );
  }

  const allDevices = devices.data ?? [];
  const limit =
    typeof entitlement.data?.entitlements["activeDevices"] === "number"
      ? (entitlement.data.entitlements["activeDevices"] as number)
      : 1;
  const activeCount = allDevices.filter((d) => d.revokedAt === null).length;
  const atLimit = isDeviceLimitReached(activeCount, limit);
  const planKey = entitlement.data?.planKey ?? "free";

  const adobeState = activationStateFor(allDevices, ADOBE_HOSTS, atLimit);
  const resolveState = activationStateFor(allDevices, RESOLVE_HOSTS, atLimit);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="plugins-page">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight">Plugins</h1>
        <p className="text-fg-2 text-sm">
          Caption your timeline right inside the app you already edit in.
        </p>
      </div>

      <ActivationCard
        testId="activation-card-adobe"
        title="Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects"
        captionCopy="Premiere: your transcript appears in Text-Based Editing. After Effects: captions drop straight onto your composition."
        channels={[
          {
            key: "premiere-uxp",
            hostLabel: "Adobe Premiere Pro",
            manifest: manifest.data?.channels["premiere-uxp"],
          },
          {
            key: "ae-cep",
            hostLabel: "Adobe After Effects",
            manifest: manifest.data?.channels["ae-cep"],
          },
        ]}
        devices={activeDevicesForHosts(allDevices, ADOBE_HOSTS)}
        state={adobeState}
        activeCount={activeCount}
        limit={limit}
        tutorialsHref="/academy?topic=premiere-panel"
        capabilityNotes={ADOBE_CAPABILITY_NOTES}
        upgradeSlot={
          <BillingUpgradeGate
            requiredPlan={nextPlanFor(planKey)}
            feature={`More than ${limit} active device${limit === 1 ? "" : "s"}`}
          />
        }
      />

      <ActivationCard
        testId="activation-card-resolve"
        title="Aksharo — works with DaVinci Resolve"
        captionCopy="Native Text+ captions land on your timeline, styled to match your project."
        channels={[
          {
            key: "resolve-script",
            hostLabel: "DaVinci Resolve (Windows/macOS/Linux)",
            manifest: manifest.data?.channels["resolve-script"],
          },
        ]}
        devices={activeDevicesForHosts(allDevices, RESOLVE_HOSTS)}
        state={resolveState}
        activeCount={activeCount}
        limit={limit}
        tutorialsHref="/academy?topic=resolve-script"
        capabilityNotes={RESOLVE_CAPABILITY_NOTES}
        upgradeSlot={
          <BillingUpgradeGate
            requiredPlan={nextPlanFor(planKey)}
            feature={`More than ${limit} active device${limit === 1 ? "" : "s"}`}
          />
        }
      />

      <LicenseKeysView />

      <p className="text-fg-2 text-xs">
        Adobe, Premiere Pro and After Effects are trademarks of Adobe Inc.; DaVinci Resolve is a
        trademark of Blackmagic Design. Aksharo is not affiliated with or endorsed by Adobe or
        Blackmagic Design.
      </p>
    </section>
  );
}
