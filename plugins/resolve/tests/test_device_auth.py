from __future__ import annotations

import httpx
import pytest

from aksharo_core_app.bridge.device_auth import (
    DeviceAuthError,
    PairingCodeInfo,
    bootstrap_device_credentials,
    refresh_device_credentials,
)

API_ORIGIN = "https://api.test"


def _client(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler, base_url=API_ORIGIN)


def test_bootstrap_device_credentials_happy_path() -> None:
    poll_calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/auth/device/code":
            return httpx.Response(
                201,
                json={
                    "deviceCode": "dc1",
                    "userCode": "ABCD1234",
                    "verificationUrl": "https://aksharo.ai/device",
                    "verificationUrlComplete": "https://aksharo.ai/device?code=ABCD1234",
                    "interval": 0,
                    "expiresIn": 60,
                },
            )
        if path == "/auth/device/token":
            poll_calls["n"] += 1
            if poll_calls["n"] < 2:
                return httpx.Response(400, json={"error": {"code": "auth/authorization_pending"}})
            return httpx.Response(
                200,
                json={"accessToken": "acc1", "refreshToken": "ref1", "expiresIn": 3600},
            )
        if path == "/devices/register":
            return httpx.Response(201, json={"id": "device-1"})
        if path == "/devices/device-1/bridge-token":
            return httpx.Response(
                201,
                json={"accessToken": "bridge-tok-1", "expiresIn": 43200, "deviceId": "device-1"},
            )
        raise AssertionError(f"unexpected request: {path}")

    seen: list[PairingCodeInfo] = []
    creds = bootstrap_device_credentials(
        API_ORIGIN,
        fingerprint="fp1",
        name="Resolve on this machine",
        platform="win32",
        on_pairing_code=seen.append,
        client=_client(httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
    )

    assert seen[0].user_code == "ABCD1234"
    assert creds.device_id == "device-1"
    assert creds.bridge_token == "bridge-tok-1"
    assert creds.session_refresh_token == "ref1"


def test_bootstrap_device_credentials_raises_on_denied_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/device/code":
            return httpx.Response(
                201,
                json={
                    "deviceCode": "dc1",
                    "userCode": "ABCD1234",
                    "verificationUrl": "https://aksharo.ai/device",
                    "verificationUrlComplete": "https://aksharo.ai/device?code=ABCD1234",
                    "interval": 0,
                    "expiresIn": 60,
                },
            )
        return httpx.Response(400, json={"error": {"code": "auth/access_denied"}})

    with pytest.raises(DeviceAuthError, match="access_denied"):
        bootstrap_device_credentials(
            API_ORIGIN,
            fingerprint="fp1",
            name="n",
            platform="win32",
            on_pairing_code=lambda _info: None,
            client=_client(httpx.MockTransport(handler)),
            sleep=lambda _seconds: None,
        )


def test_refresh_device_credentials_happy_path() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/refresh":
            return httpx.Response(
                200, json={"accessToken": "acc2", "refreshToken": "ref2", "expiresIn": 3600}
            )
        if request.url.path == "/devices/device-1/bridge-token":
            return httpx.Response(
                201,
                json={"accessToken": "bridge-tok-2", "expiresIn": 43200, "deviceId": "device-1"},
            )
        raise AssertionError(f"unexpected request: {request.url.path}")

    creds = refresh_device_credentials(
        API_ORIGIN, "device-1", "ref1", client=_client(httpx.MockTransport(handler))
    )
    assert creds.bridge_token == "bridge-tok-2"
    assert creds.session_refresh_token == "ref2"


def test_refresh_device_credentials_raises_on_revoked_refresh_token() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "auth/invalid_grant"}})

    with pytest.raises(DeviceAuthError, match="invalid_grant"):
        refresh_device_credentials(
            API_ORIGIN, "device-1", "ref1", client=_client(httpx.MockTransport(handler))
        )
