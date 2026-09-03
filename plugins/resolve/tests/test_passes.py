from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from aksharo_core_app.passes import ListPassesOptions, list_passes


@dataclass
class FakeHttp:
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    response: dict[str, Any] = field(default_factory=lambda: {"passes": []})

    async def get_json(self, url: str, headers: dict[str, str]) -> dict[str, Any]:
        self.calls.append((url, headers))
        return self.response


async def test_list_passes_calls_the_documented_route() -> None:
    http = FakeHttp(response={"passes": [{"passId": "pass_1", "type": "autocut", "items": []}]})
    options = ListPassesOptions(
        http=http, api_origin="https://api.aksharo.ai", session_token="tok", project_id="proj_1"
    )

    result = await list_passes(options)

    assert result == {"passes": [{"passId": "pass_1", "type": "autocut", "items": []}]}
    assert http.calls == [
        ("https://api.aksharo.ai/projects/proj_1/edg/passes", {"authorization": "Bearer tok"})
    ]
