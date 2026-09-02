import type { DeviceHost, DeviceView, PluginManifestChannel } from "@montaj/api-client";

/**
 * Shared activation-state logic for the Plugins page (08 §4 "the activation
 * card (v2)") and the Passes tab's licensing cue (08 §4 "Passes tab licensing
 * cues") -- both read the same `useDevices()` / `useEntitlement()` data and
 * must agree on what "installed", "not installed" and "limit reached" mean,
 * so the derivation lives once, here, rather than being reimplemented per
 * screen.
 */
export type PluginActivationState = "signed_in" | "not_installed" | "limit_reached";

/** Every plugin `DeviceHost` value the activation card and cue ever ask about. */
export const ADOBE_HOSTS: readonly DeviceHost[] = ["premiere", "ae"];
export const RESOLVE_HOSTS: readonly DeviceHost[] = ["resolve"];

export function activeDevicesForHosts(
  devices: readonly DeviceView[],
  hosts: readonly DeviceHost[],
): DeviceView[] {
  return devices.filter((device) => hosts.includes(device.host) && device.revokedAt === null);
}

/**
 * `not_installed` unless a device for this product is already signed in
 * (`signed_in` wins over `limit_reached` -- a workspace at its device limit
 * has, by definition, at least one active device, and an already-signed-in
 * plugin keeps working regardless of the limit; the limit only blocks a
 * *new* device from joining).
 */
export function activationStateFor(
  devices: readonly DeviceView[],
  hosts: readonly DeviceHost[],
  atLimit: boolean,
): PluginActivationState {
  if (activeDevicesForHosts(devices, hosts).length > 0) return "signed_in";
  return atLimit ? "limit_reached" : "not_installed";
}

export const ACTIVATION_STATE_LABEL: Record<PluginActivationState, string> = {
  signed_in: "Installed and signed in",
  not_installed: "Not installed",
  limit_reached: "Device limit reached",
};

export function isDeviceLimitReached(activeCount: number, limit: number): boolean {
  return activeCount >= limit;
}

/** A channel with no download URL yet (C10 has not landed). */
export function channelUnavailable(channel: PluginManifestChannel | undefined): boolean {
  return channel === undefined || !channel.available;
}
