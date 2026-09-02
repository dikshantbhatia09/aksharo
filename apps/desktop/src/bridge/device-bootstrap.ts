/**
 * Device bootstrap (brief §2): on first run, registers this install as a
 * device (B08 `POST /devices/register`) and mints a `kind:"bridge"` access
 * token (B08b `POST /devices/{id}/bridge-token`) for the embedded bridge —
 * one flow, cached in the OS keystore (`@montaj/bridge-core`'s
 * `createDefaultKeyStore`, THREAT-MODEL T14) so a restart doesn't re-register
 * while the lease is still valid.
 *
 * Requires a user access token, supplied by `getAccessToken()`. The desktop
 * shell does not duplicate the hosted web app's OAuth flow (decision D71):
 * the caller is expected to obtain this from the signed-in hosted app running
 * in the main window (see `src/main/index.ts`'s "Open questions" note — the
 * IPC hand-off itself is out of `apps/desktop`'s `apps/web` boundary for this
 * WP). Returns `undefined` rather than throwing when no access token is
 * available yet ("not signed in"), so callers can retry later without
 * treating it as an error.
 *
 * Never logs `deviceToken` in plaintext (THREAT-MODEL T13/T14) — only
 * `deviceId`/`expiresAt` reach `log`.
 */
import { randomUUID } from "node:crypto";

import { createDefaultKeyStore } from "@montaj/bridge-core";
import type { KeyStore } from "@montaj/bridge-core";

const DEVICE_FINGERPRINT_KEY = "device-fingerprint";
const DEVICE_ID_KEY = "device-id";
const DEVICE_TOKEN_KEY = "device-bridge-token";
const DEVICE_TOKEN_EXPIRES_AT_KEY = "device-bridge-token-expires-at";

/** Refresh this many ms before the cached bridge token actually expires. */
const REFRESH_SKEW_MS = 60_000;

export interface DeviceBootstrapDeps {
  readonly apiOrigin: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion?: string;
  /** `undefined` when the user isn't signed in yet (or the caller hasn't wired this up). */
  readonly getAccessToken: () => string | undefined;
  readonly keyStore?: KeyStore;
  readonly log?: (line: Record<string, unknown>) => void;
  readonly fetchImpl?: typeof fetch;
}

export interface DeviceBridgeCredential {
  readonly deviceId: string;
  readonly deviceToken: string;
}

interface DeviceRegisterResponse {
  readonly id: string;
}

interface BridgeTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly deviceId: string;
}

async function ensureFingerprint(keyStore: KeyStore): Promise<string> {
  const existing = await keyStore.load(DEVICE_FINGERPRINT_KEY);
  if (existing !== undefined) return existing;
  const generated = randomUUID();
  await keyStore.save(DEVICE_FINGERPRINT_KEY, generated);
  return generated;
}

async function registerDevice(
  deps: DeviceBootstrapDeps,
  fetchImpl: typeof fetch,
  accessToken: string,
  fingerprint: string,
): Promise<DeviceRegisterResponse> {
  const res = await fetchImpl(`${deps.apiOrigin}/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      fingerprint,
      name: deps.deviceName,
      platform: deps.platform,
      host: "desktop",
      ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`device registration failed with status ${res.status}`);
  }
  return (await res.json()) as DeviceRegisterResponse;
}

async function mintBridgeToken(
  deps: DeviceBootstrapDeps,
  fetchImpl: typeof fetch,
  accessToken: string,
  deviceId: string,
): Promise<BridgeTokenResponse> {
  const res = await fetchImpl(`${deps.apiOrigin}/devices/${deviceId}/bridge-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`bridge token mint failed with status ${res.status}`);
  }
  return (await res.json()) as BridgeTokenResponse;
}

/**
 * Returns the cached credential if the lease is still fresh; otherwise
 * registers the device and mints a new bridge token (requires an access
 * token). Returns `undefined` only when there is no access token yet.
 */
export async function bootstrapDevice(
  deps: DeviceBootstrapDeps,
): Promise<DeviceBridgeCredential | undefined> {
  const keyStore = deps.keyStore ?? (await createDefaultKeyStore());
  const fetchImpl = deps.fetchImpl ?? fetch;

  const [cachedToken, cachedDeviceId, cachedExpiresAt] = await Promise.all([
    keyStore.load(DEVICE_TOKEN_KEY),
    keyStore.load(DEVICE_ID_KEY),
    keyStore.load(DEVICE_TOKEN_EXPIRES_AT_KEY),
  ]);
  if (
    cachedToken !== undefined &&
    cachedDeviceId !== undefined &&
    cachedExpiresAt !== undefined &&
    Date.parse(cachedExpiresAt) - REFRESH_SKEW_MS > Date.now()
  ) {
    return { deviceId: cachedDeviceId, deviceToken: cachedToken };
  }

  const accessToken = deps.getAccessToken();
  if (accessToken === undefined) return undefined;

  const fingerprint = await ensureFingerprint(keyStore);
  const device = await registerDevice(deps, fetchImpl, accessToken, fingerprint);
  const bridgeToken = await mintBridgeToken(deps, fetchImpl, accessToken, device.id);

  const expiresAt = new Date(Date.now() + bridgeToken.expiresIn * 1000).toISOString();
  await Promise.all([
    keyStore.save(DEVICE_ID_KEY, device.id),
    keyStore.save(DEVICE_TOKEN_KEY, bridgeToken.accessToken),
    keyStore.save(DEVICE_TOKEN_EXPIRES_AT_KEY, expiresAt),
  ]);

  deps.log?.({ evt: "device.bootstrap", deviceId: device.id, expiresAt });

  return { deviceId: device.id, deviceToken: bridgeToken.accessToken };
}
