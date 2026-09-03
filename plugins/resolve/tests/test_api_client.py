"""Mock-backed tests for `api_client.py` (D09 orchestrator addendum after C05a/C05b/C09):
`GET /styles`, `GET /projects/{id}/transcript`, `GET /projects/{id}/edg/segments`, each carrying
a bearer auth header.
"""

from __future__ import annotations

import httpx

from aksharo_core_app.api_client import (
    ApiClientConfig,
    get_project_edg_segments,
    get_project_transcript,
    get_styles,
)

API_ORIGIN = "https://api.aksharo.ai"
CONFIG = ApiClientConfig(api_origin=API_ORIGIN, session_token="sess-token-1")


def _client(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler)


def test_get_styles_sends_bearer_auth_and_returns_the_catalogue() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"presetId": "system-1", "source": "system"}])

    result = get_styles(CONFIG, _client(httpx.MockTransport(handler)))

    assert result == [{"presetId": "system-1", "source": "system"}]
    assert len(seen) == 1
    assert str(seen[0].url) == f"{API_ORIGIN}/styles"
    assert seen[0].headers["authorization"] == "Bearer sess-token-1"


def test_get_project_transcript_url_encodes_the_project_id() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"transcriptId": "t1", "revision": 3, "chunks": []})

    result = get_project_transcript(CONFIG, _client(httpx.MockTransport(handler)), "proj a/b")

    assert result["transcriptId"] == "t1"
    assert str(seen[0].url) == f"{API_ORIGIN}/projects/proj%20a%2Fb/transcript"


def test_get_project_edg_segments() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"revision": 7, "segments": []})

    result = get_project_edg_segments(CONFIG, _client(httpx.MockTransport(handler)), "proj-1")

    assert result == {"revision": 7, "segments": []}
    assert str(seen[0].url) == f"{API_ORIGIN}/projects/proj-1/edg/segments"


def test_get_styles_raises_on_a_non_2xx_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "auth/unauthorized"}})

    try:
        get_styles(CONFIG, _client(httpx.MockTransport(handler)))
    except httpx.HTTPStatusError as exc:
        assert exc.response.status_code == 401
    else:
        raise AssertionError("expected an HTTPStatusError for a 401 response")
