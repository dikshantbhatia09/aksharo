"""Device-code bootstrap for this script's bridge/API credential (B08b).

Python port of `apps/bridge/src/device-auth.ts`: this process has no user
sitting at it, so it uses the RFC 8628 device-code grant with
`clientKind: "resolve"` (bridge-core's `ClientKindSchema`), opening the
verification URL in the *system* browser (`webbrowser.open`, brief §2:
"device-code in the system browser") for a human to approve, then:

  1. registers this machine as a B08 device (`POST /devices/register`);
  2. mints the bridge credential (`POST /devices/{id}/bridge-token`).

`refresh_device_credentials` re-mints a bridge token from a device already
registered on an earlier run using the session's refresh token
(`POST /auth/refresh`), with no second approval screen unless that refresh
token was itself revoked.
"""

from __future__ import annotations

import time
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx


class DeviceAuthError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class PairingCodeInfo:
    user_code: str
    verification_url_complete: str
    expires_in: int


@dataclass(frozen=True, slots=True)
class DeviceCredentials:
    device_id: str
    session_refresh_token: str
    bridge_token: str
    bridge_token_expires_at_ms: float


def _post_json(
    client: httpx.Client, url: str, body: dict[str, Any], headers: dict[str, str] | None = None
) -> tuple[int, dict[str, Any]]:
    response = client.post(url, json=body, headers=headers or {})
    try:
        parsed = response.json()
    except ValueError:
        parsed = {}
    return response.status_code, parsed if isinstance(parsed, dict) else {}


def open_in_system_browser(url: str) -> None:
    """`webbrowser.open` — a human approves the device code out-of-band."""
    webbrowser.open(url)


def bootstrap_device_credentials(
    api_origin: str,
    fingerprint: str,
    name: str,
    platform: str,
    on_pairing_code: Callable[[PairingCodeInfo], None] = lambda info: open_in_system_browser(
        info.verification_url_complete
    ),
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> DeviceCredentials:
    """Full first-run flow: device code -> human approval -> register -> bridge token."""
    owns_client = client is None
    http = client or httpx.Client(timeout=10.0)
    try:
        status, body = _post_json(http, f"{api_origin}/auth/device/code", {"clientKind": "resolve"})
        if status != 201:
            raise DeviceAuthError(f"could not start device sign-in (HTTP {status})")
        on_pairing_code(
            PairingCodeInfo(
                user_code=body["userCode"],
                verification_url_complete=body["verificationUrlComplete"],
                expires_in=body["expiresIn"],
            )
        )

        session = _poll_for_session(http, sleep, api_origin, body)
        device = _register_device(
            http, api_origin, fingerprint, name, platform, session["accessToken"]
        )
        bridge_token = _mint_bridge_token(http, api_origin, session["accessToken"], device["id"])

        return DeviceCredentials(
            device_id=device["id"],
            session_refresh_token=session["refreshToken"],
            bridge_token=bridge_token["accessToken"],
            bridge_token_expires_at_ms=time.time() * 1000 + bridge_token["expiresIn"] * 1000,
        )
    finally:
        if owns_client:
            http.close()


def refresh_device_credentials(
    api_origin: str,
    device_id: str,
    session_refresh_token: str,
    client: httpx.Client | None = None,
) -> DeviceCredentials:
    owns_client = client is None
    http = client or httpx.Client(timeout=10.0)
    try:
        status, body = _post_json(
            http, f"{api_origin}/auth/refresh", {"refreshToken": session_refresh_token}
        )
        if status != 200:
            code = (body.get("error") or {}).get("code", "unknown")
            raise DeviceAuthError(f"could not refresh the bridge's session (HTTP {status}, {code})")
        bridge_token = _mint_bridge_token(http, api_origin, body["accessToken"], device_id)
        return DeviceCredentials(
            device_id=device_id,
            session_refresh_token=body["refreshToken"],
            bridge_token=bridge_token["accessToken"],
            bridge_token_expires_at_ms=time.time() * 1000 + bridge_token["expiresIn"] * 1000,
        )
    finally:
        if owns_client:
            http.close()


def _poll_for_session(
    http: httpx.Client,
    sleep: Callable[[float], None],
    api_origin: str,
    grant: dict[str, Any],
) -> dict[str, Any]:
    deadline = time.time() + grant["expiresIn"]
    interval = grant["interval"]
    while time.time() < deadline:
        sleep(interval)
        status, body = _post_json(
            http, f"{api_origin}/auth/device/token", {"deviceCode": grant["deviceCode"]}
        )
        if status == 200:
            return body
        code = (body.get("error") or {}).get("code")
        if code == "auth/authorization_pending":
            continue
        if code == "auth/slow_down":
            interval = (body.get("error") or {}).get("details", {}).get("interval", interval + 5)
            continue
        raise DeviceAuthError(f"device sign-in failed: {code or status}")
    raise DeviceAuthError("device sign-in timed out waiting for approval")


def _register_device(
    http: httpx.Client,
    api_origin: str,
    fingerprint: str,
    name: str,
    platform: str,
    session_access_token: str,
) -> dict[str, Any]:
    status, body = _post_json(
        http,
        f"{api_origin}/devices/register",
        {"fingerprint": fingerprint, "name": name, "platform": platform, "host": "resolve"},
        {"authorization": f"Bearer {session_access_token}"},
    )
    if status != 201:
        code = (body.get("error") or {}).get("code", "unknown")
        raise DeviceAuthError(f"could not register this device (HTTP {status}, {code})")
    return body


def _mint_bridge_token(
    http: httpx.Client, api_origin: str, session_access_token: str, device_id: str
) -> dict[str, Any]:
    status, body = _post_json(
        http,
        f"{api_origin}/devices/{device_id}/bridge-token",
        {},
        {"authorization": f"Bearer {session_access_token}"},
    )
    if status != 201:
        code = (body.get("error") or {}).get("code", "unknown")
        raise DeviceAuthError(f"could not mint a bridge token (HTTP {status}, {code})")
    return body
