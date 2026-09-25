"use client";

import Link from "next/link";
import * as React from "react";

import { useDevices, useEntitlement } from "@montaj/api-client";
import { Badge } from "@montaj/ui";

import {
  ACTIVATION_STATE_LABEL,
  ADOBE_HOSTS,
  RESOLVE_HOSTS,
  activationStateFor,
  isDeviceLimitReached,
  type PluginActivationState,
} from "@/components/plugins/plugin-status";

const STATE_TONE: Record<PluginActivationState, "accepted" | "neutral" | "warning"> = {
  signed_in: "accepted",
  not_installed: "neutral",
  limit_reached: "warning",
};

/**
 * Passes tab licensing cue (08 §4 "Passes tab licensing cues", brief §3): the
 * "Apply in Premiere/Resolve" affordance shows the plugin's activation state
 * -- installed + signed in / not installed / limit reached -- using exactly
 * the same `devices` + `entitlement` data the Plugins page reads
 * (`components/plugins/plugin-status.ts`). No plugin code lives here; this
 * is a read-only status badge plus a link to the Plugins page for whichever
 * host app is not yet ready.
 */
export function PluginActivationCue({
  host,
}: {
  readonly host: "premiere" | "resolve";
}): React.JSX.Element | null {
  const devices = useDevices();
  const entitlement = useEntitlement();

  if (devices.isPending || entitlement.isPending || devices.isError || entitlement.isError) {
    return null;
  }

  const hosts = host === "premiere" ? ADOBE_HOSTS : RESOLVE_HOSTS;
  const limit =
    typeof entitlement.data.entitlements["activeDevices"] === "number"
      ? (entitlement.data.entitlements["activeDevices"] as number)
      : 1;
  const activeCount = (devices.data ?? []).filter((d) => d.revokedAt === null).length;
  const atLimit = isDeviceLimitReached(activeCount, limit);
  const state = activationStateFor(devices.data ?? [], hosts, atLimit);

  return (
    <div className="flex items-center gap-2 text-xs" data-testid={`passes-plugin-cue-${host}`}>
      <span className="text-fg-2">Apply in {host === "premiere" ? "Premiere" : "Resolve"}</span>
      {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
      <Badge tone={STATE_TONE[state]}>{ACTIVATION_STATE_LABEL[state]}</Badge>
      {state === "signed_in" ? null : (
        <Link
          href="/plugins"
          className="text-accent-300 hover:text-accent-200 rounded-sm underline underline-offset-2"
        >
          Set up
        </Link>
      )}
    </div>
  );
}
