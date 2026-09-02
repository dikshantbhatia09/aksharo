"""Replaying recorded vendor HTTP so an adapter can be run without a key.

No vendor key exists yet (A00-06). That is not a reason to leave three adapters
untested until one does: an ASR adapter is mostly a *parser*, and a parser is
exactly the thing a recorded response tests properly. So every vendor exchange
this worker makes is recorded as JSON under ``worker_ai/fixtures/vendor/<vendor>/``
and replayed through an ``httpx2.MockTransport``, which means the adapter under
test is the real adapter — real retries, real polling, real field names — with
only the socket replaced.

A session file is a list of exchanges in the order the adapter makes them:

```json
{ "provider": "sarvam",
  "baseUrl": "https://api.sarvam.test",
  "exchanges": [
    { "method": "POST", "path": "/speech-to-text/job/init", "status": 200,
      "json": { "job_id": "job-1" } },
    { "method": "GET",  "path": "/speech-to-text/job/job-1/status", "status": 200,
      "json": { "job_state": "Running" }, "repeat": 2 }
  ] }
```

Matching is **by position, then by shape**: the transport walks its remaining
exchanges and takes the first whose method matches and whose ``path`` is a suffix
of the request path (so an absolute Azure blob URL matches ``azure/input``). An
unmatched request is a 599 with a message naming what was asked for, because a
silent 404 in a replay is a debugging afternoon.

**Fixtures never contain a credential.** The recorded bodies are hand-written
from vendor documentation, the base URLs are ``.test`` hosts, and nothing in this
directory has ever been near a real account.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2

from worker_ai.providers.base import Provider

__all__ = [
    "FIXTURE_FOR",
    "VENDOR_FIXTURES_DIR",
    "Exchange",
    "ReplaySession",
    "build_replay_provider",
    "load_session",
    "replay_transport",
]

#: Recorded vendor exchanges ship inside the package, like the eval sets.
VENDOR_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "vendor"

#: Where a provider's default session lives, when the directory is not its name.
#: The GPU endpoint's session also carries ``/diarise`` and ``/detect-language``,
#: so it is named for the model server rather than for the adapter (D15).
FIXTURE_FOR: dict[str, str] = {"serverless-whisper": "gpu-whisper"}


@dataclass(slots=True)
class Exchange:
    """One recorded request/response pair."""

    method: str
    path: str
    status: int = 200
    json_body: Any = None
    text: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    #: How many times this exchange may be served; a poll loop needs more than one.
    repeat: int = 1
    served: int = 0

    @property
    def exhausted(self) -> bool:
        return self.served >= self.repeat

    def matches(self, request: httpx2.Request) -> bool:
        if request.method.upper() != self.method.upper():
            return False
        target = str(request.url)
        return self.path in target or target.endswith(self.path)

    def respond(self) -> httpx2.Response:
        self.served += 1
        if self.json_body is not None:
            return httpx2.Response(self.status, json=self.json_body, headers=self.headers)
        return httpx2.Response(self.status, text=self.text, headers=self.headers)


@dataclass(slots=True)
class ReplaySession:
    """A whole recorded conversation with one vendor."""

    provider: str
    base_url: str
    exchanges: list[Exchange]
    #: Every request the adapter actually made, for a test to assert against.
    seen: list[httpx2.Request] = field(default_factory=list)

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.seen.append(request)
        for exchange in self.exchanges:
            if exchange.exhausted or not exchange.matches(request):
                continue
            return exchange.respond()
        return httpx2.Response(
            599,
            json={
                "error": "no recorded exchange for "
                + request.method
                + " "
                + str(request.url),
                "provider": self.provider,
            },
        )

    def paths(self) -> list[str]:
        """The path of every request made, in order."""
        return [request.url.path for request in self.seen]


def load_session(reference: str | Path, root: Path | None = None) -> ReplaySession:
    """Load ``<vendor>/session.json``, by vendor name or by path."""
    directory = Path(reference)
    if not directory.is_dir():
        directory = (root or VENDOR_FIXTURES_DIR) / Path(reference).name
    path = directory / "session.json"
    if not path.is_file():
        raise FileNotFoundError("no recorded session at " + str(path))
    raw: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(str(path) + " must hold an object")
    exchanges = [
        Exchange(
            method=str(item.get("method", "GET")),
            path=str(item.get("path", "")),
            status=int(item.get("status", 200)),
            json_body=item.get("json"),
            text=str(item.get("text", "")),
            headers={str(key): str(value) for key, value in (item.get("headers") or {}).items()},
            repeat=int(item.get("repeat", 1)),
        )
        for item in raw.get("exchanges", [])
        if isinstance(item, dict)
    ]
    if not exchanges:
        raise ValueError(str(path) + " records no exchanges")
    return ReplaySession(
        provider=str(raw.get("provider") or directory.name),
        base_url=str(raw.get("baseUrl") or "https://vendor.test"),
        exchanges=exchanges,
    )


def replay_transport(session: ReplaySession) -> httpx2.MockTransport:
    """A transport that serves ``session`` and records what was asked for."""
    return httpx2.MockTransport(lambda request: session.handle(request))


def build_replay_provider(
    provider: str, reference: str | Path | None = None, root: Path | None = None
) -> tuple[Provider, ReplaySession]:
    """A real adapter wired to a recorded session — the eval harness's vendor lane.

    :param provider: registry name (``elevenlabs``, ``sarvam``, ``assemblyai``,
        ``serverless-whisper``).
    :param reference: fixture directory; defaults to the vendor's own.
    """
    session = load_session(reference or FIXTURE_FOR.get(provider, provider), root)
    client = httpx2.AsyncClient(transport=replay_transport(session))

    if provider == "elevenlabs":
        from worker_ai.providers.elevenlabs import ElevenLabsScribeProvider

        return (
            ElevenLabsScribeProvider(
                "replay-key", base_url=session.base_url, client=client
            ),
            session,
        )
    if provider == "sarvam":
        from worker_ai.providers.sarvam import SarvamSaarasProvider

        return (
            SarvamSaarasProvider(
                "replay-key",
                base_url=session.base_url,
                poll_interval_s=0.0,
                client=client,
            ),
            session,
        )
    if provider == "assemblyai":
        from worker_ai.providers.assemblyai import AssemblyAiProvider

        return (
            AssemblyAiProvider(
                "replay-key",
                base_url=session.base_url,
                poll_interval_s=0.0,
                client=client,
            ),
            session,
        )
    if provider == "serverless-whisper":
        from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

        # A fixture string, never a credential: the replay transport ignores it.
        token = "replay"  # noqa: S105
        return (
            ServerlessWhisperProvider(session.base_url, token=token, client=client),
            session,
        )
    raise ValueError("no replay wiring for provider " + repr(provider))
