"""Shared API client (orchestrator addendum 2026-09-03, after C05a/C05b/C09): "the panels call
the existing API through the bridge — `GET /styles` (A14) for style docs and
`GET /projects/{id}/transcript` (A11) / `GET /projects/{id}/edg/segments` (A12) for segments —
wrapped in one shared client module per plugin; D09 adds that wiring and its mock-backed tests
alongside the apply-plan builder."

Python port of `plugins/premiere-uxp/src/api/client.ts`'s same three calls, over `httpx`
(already this package's HTTP dependency, see `bridge/device_auth.py`) rather than the bridge's
JSON-RPC protocol (which has no generic REST-proxy method, `bridge/protocol.py`) — same "plain
HTTPS call bearing the panel's own session token" pattern that module documents.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import quote

import httpx


@dataclass(frozen=True, slots=True)
class ApiClientConfig:
    api_origin: str
    session_token: str


def _auth_headers(session_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {session_token}"}


def get_styles(config: ApiClientConfig, client: httpx.Client) -> list[dict[str, Any]]:
    """`GET /styles` (A14): the style catalogue (system styles + this workspace's presets)."""
    headers = _auth_headers(config.session_token)
    response = client.get(f"{config.api_origin}/styles", headers=headers)
    response.raise_for_status()
    return cast("list[dict[str, Any]]", response.json())


def get_project_transcript(
    config: ApiClientConfig, client: httpx.Client, project_id: str
) -> dict[str, Any]:
    """`GET /projects/{id}/transcript` (A11): the project's transcript chunks/words."""
    url = f"{config.api_origin}/projects/{quote(project_id, safe='')}/transcript"
    response = client.get(url, headers=_auth_headers(config.session_token))
    response.raise_for_status()
    return cast("dict[str, Any]", response.json())


def get_project_edg_segments(
    config: ApiClientConfig, client: httpx.Client, project_id: str
) -> dict[str, Any]:
    """`GET /projects/{id}/edg/segments` (A12): the project's current EDG segments."""
    url = f"{config.api_origin}/projects/{quote(project_id, safe='')}/edg/segments"
    response = client.get(url, headers=_auth_headers(config.session_token))
    response.raise_for_status()
    return cast("dict[str, Any]", response.json())
