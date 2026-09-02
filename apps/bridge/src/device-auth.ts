/**
 * First-run and refresh bootstrap for the bridge's own credential (B08b,
 * brief §3).
 *
 * The bridge process has no user sitting at it, so it cannot sign in itself —
 * it uses the same RFC 8628 device-code grant `auth/device.controller.ts`
 * gives every headless client (desktop app, plugin panels), requested with
 * `clientKind: "desktop"` so the flow hands back an ordinary user session
 * rather than a bridge credential directly: `TokenService.mintAccessToken`
 * now refuses to mint a `kind:"bridge"` token without a `deviceId`
 * (CONTRACTS §5 amended 2026-09-03), and no B08 device row exists yet at
 * that point in the flow. Once a human approves the 8-character code on
 * their phone or laptop, this module:
 *
 *   1. registers this machine as a B08 device (`POST /devices/register`)
 *      with the session token the device-code flow returned;
 *   2. mints the actual bridge credential (`POST /devices/{id}/bridge-token`),
 *      which is what `RelayClient`/`BridgeCore` present to `/bridge/relay`.
 *
 * `refreshDeviceCredentials` re-mints a bridge token from a device already
 * registered on an earlier run, using the session's own refresh token
 * (`POST /auth/refresh`) — no pairing screen the second time, unless the
 * refresh token itself has been revoked (sign-out, a leaked-token incident),
 * in which case the caller falls back to `bootstrapDeviceCredentials` again.
 *
 * On-disk storage of the resulting tokens is `config.ts`'s job, not this
 * module's — the keychain/DPAPI upgrade the bridge README still calls out as
 * open (C01b) applies there, unchanged by B08b.
 */

export class DeviceAuthError extends Error {
  public override readonly name = "DeviceAuthError";
}

interface DeviceCodeResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly verificationUrlComplete: string;
  readonly interval: number;
  readonly expiresIn: number;
}

interface SessionTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

interface DeviceRegisterResponse {
  readonly id: string;
}

interface BridgeTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly deviceId: string;
}

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly details?: { readonly interval?: number } };
}

export interface PairingCodeInfo {
  readonly userCode: string;
  readonly verificationUrlComplete: string;
  readonly expiresIn: number;
}

export interface DeviceAuthOptions {
  readonly apiOrigin: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly platform: string;
  readonly hostVersion?: string;
  readonly appVersion?: string;
  /** Called once the device code exists, so the caller can show/log it. */
  readonly onPairingCode: (info: PairingCodeInfo) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DeviceCredentials {
  readonly deviceId: string;
  readonly sessionRefreshToken: string;
  readonly bridgeToken: string;
  /** Epoch ms. */
  readonly bridgeTokenExpiresAt: number;
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T & ErrorEnvelope }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed as T & ErrorEnvelope };
}

/** Full first-run flow: device code -> human approval -> register -> bridge token. */
export async function bootstrapDeviceCredentials(
  options: DeviceAuthOptions,
): Promise<DeviceCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const codeRes = await postJson<DeviceCodeResponse>(
    fetchImpl,
    `${options.apiOrigin}/auth/device/code`,
    { clientKind: "desktop" },
  );
  if (codeRes.status !== 201) {
    throw new DeviceAuthError(`could not start device sign-in (HTTP ${String(codeRes.status)})`);
  }
  const grant = codeRes.body;
  options.onPairingCode({
    userCode: grant.userCode,
    verificationUrlComplete: grant.verificationUrlComplete,
    expiresIn: grant.expiresIn,
  });

  const session = await pollForSession(fetchImpl, sleep, options.apiOrigin, grant);
  const device = await registerDevice(fetchImpl, options, session.accessToken);
  const bridgeToken = await mintBridgeToken(
    fetchImpl,
    options.apiOrigin,
    session.accessToken,
    device.id,
  );

  return {
    deviceId: device.id,
    sessionRefreshToken: session.refreshToken,
    bridgeToken: bridgeToken.accessToken,
    bridgeTokenExpiresAt: Date.now() + bridgeToken.expiresIn * 1000,
  };
}

/** Re-mint a bridge token for a device already registered on an earlier run. */
export async function refreshDeviceCredentials(
  apiOrigin: string,
  deviceId: string,
  sessionRefreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<DeviceCredentials, "deviceId">> {
  const refreshed = await postJson<SessionTokenResponse>(fetchImpl, `${apiOrigin}/auth/refresh`, {
    refreshToken: sessionRefreshToken,
  });
  if (refreshed.status !== 200) {
    throw new DeviceAuthError(
      `could not refresh the bridge's session (HTTP ${String(refreshed.status)}, ` +
        `${refreshed.body.error?.code ?? "unknown"})`,
    );
  }
  const bridgeToken = await mintBridgeToken(
    fetchImpl,
    apiOrigin,
    refreshed.body.accessToken,
    deviceId,
  );
  return {
    sessionRefreshToken: refreshed.body.refreshToken,
    bridgeToken: bridgeToken.accessToken,
    bridgeTokenExpiresAt: Date.now() + bridgeToken.expiresIn * 1000,
  };
}

async function pollForSession(
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  apiOrigin: string,
  grant: DeviceCodeResponse,
): Promise<SessionTokenResponse> {
  const deadline = Date.now() + grant.expiresIn * 1000;
  let interval = grant.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await postJson<SessionTokenResponse>(fetchImpl, `${apiOrigin}/auth/device/token`, {
      deviceCode: grant.deviceCode,
    });
    if (res.status === 200) return res.body;

    const code = res.body.error?.code;
    if (code === "auth/authorization_pending") continue;
    if (code === "auth/slow_down") {
      interval = res.body.error?.details?.interval ?? interval + 5;
      continue;
    }
    throw new DeviceAuthError(`device sign-in failed: ${code ?? String(res.status)}`);
  }
  throw new DeviceAuthError("device sign-in timed out waiting for approval");
}

async function registerDevice(
  fetchImpl: typeof fetch,
  options: DeviceAuthOptions,
  sessionAccessToken: string,
): Promise<DeviceRegisterResponse> {
  const res = await postJson<DeviceRegisterResponse>(
    fetchImpl,
    `${options.apiOrigin}/devices/register`,
    {
      fingerprint: options.fingerprint,
      name: options.name,
      platform: options.platform,
      host: "desktop",
      ...(options.hostVersion === undefined ? {} : { hostVersion: options.hostVersion }),
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    },
    { authorization: `Bearer ${sessionAccessToken}` },
  );
  if (res.status !== 201) {
    throw new DeviceAuthError(
      `could not register this device (HTTP ${String(res.status)}, ${res.body.error?.code ?? "unknown"})`,
    );
  }
  return res.body;
}

async function mintBridgeToken(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  sessionAccessToken: string,
  deviceId: string,
): Promise<BridgeTokenResponse> {
  const res = await postJson<BridgeTokenResponse>(
    fetchImpl,
    `${apiOrigin}/devices/${deviceId}/bridge-token`,
    {},
    { authorization: `Bearer ${sessionAccessToken}` },
  );
  if (res.status !== 201) {
    throw new DeviceAuthError(
      `could not mint a bridge token (HTTP ${String(res.status)}, ${res.body.error?.code ?? "unknown"})`,
    );
  }
  return res.body;
}
