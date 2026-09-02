"""`passes.list` loopback method (`server.py`'s `PanelDeps`): fetches the
current project's pass-item summary from the API
(`GET /projects/{id}/edg/passes`, `apps/api/src/passes/passes.controller.ts`,
same data A12 already serves) so the C09 panel can render its "Passes review
summary" list. This module only shapes the request/response; applying
accepted items onto the Resolve timeline is `cuts.py`/`zooms.py`/
`captions.py`, invoked through the loopback server's `apply.*` methods, which
this module never touches.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class PassesHttpClient(Protocol):
    async def get_json(self, url: str, headers: dict[str, str]) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class ListPassesOptions:
    http: PassesHttpClient
    api_origin: str
    session_token: str
    project_id: str


async def list_passes(options: ListPassesOptions) -> dict[str, Any]:
    """Returns the API's `PassSummaryListDto` shape verbatim; the panel is
    the one that decides how to group/display it."""
    return await options.http.get_json(
        f"{options.api_origin}/projects/{options.project_id}/edg/passes",
        {"authorization": f"Bearer {options.session_token}"},
    )


__all__ = ["ListPassesOptions", "PassesHttpClient", "list_passes"]
