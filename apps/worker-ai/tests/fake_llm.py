"""A language model for tests: answers from a function of the request, no network."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from worker_ai.llm.providers.base import LlmError, LlmProvider, LlmRequest, LlmResponse, LlmUsage

Reply = str | dict[str, Any] | LlmError


class FakeLlm(LlmProvider):
    """Replies with ``answer(request)``: a string, a dict (sent as JSON), or an error."""

    def __init__(
        self,
        answer: Callable[[LlmRequest], Reply],
        *,
        name: str = "fake",
        model: str = "fake-model",
        regions: frozenset[str] = frozenset({"in", "eu", "us"}),
        usage: LlmUsage | None = None,
        max_prompt_chars: int = 60_000,
    ) -> None:
        self.name = name
        self.model = model
        self.supported_regions = regions
        self.max_prompt_chars = max_prompt_chars
        self._answer = answer
        self._usage = usage or LlmUsage(input_tokens=1_000, output_tokens=200)
        self.requests: list[LlmRequest] = []

    async def generate(self, request: LlmRequest) -> LlmResponse:
        self.requests.append(request)
        reply = self._answer(request)
        if isinstance(reply, LlmError):
            raise reply
        text = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
        return LlmResponse(text=text, usage=self._usage, endpoint=f"fake://{self.name}")


def failing(name: str = "fake", *, retryable: bool = False) -> FakeLlm:
    """A provider that is always down."""
    return FakeLlm(
        lambda _request: LlmError(f"{name} is down", provider=name, retryable=retryable),
        name=name,
    )


def moment_blocks(request: LlmRequest) -> dict[str, str]:
    """The ``<moment id>`` blocks of a highlight-judgement prompt: id -> its words."""
    return {
        match.group(1): match.group(2)
        for match in re.finditer(
            r'<moment id="([^"]+)">.*?<text>(.*?)</text>', request.user, flags=re.DOTALL
        )
    }


def clip_blocks(request: LlmRequest) -> dict[str, str]:
    """The ``<clip id>`` blocks of a copy prompt: id -> its words."""
    return {
        match.group(1): match.group(2)
        for match in re.finditer(
            r'<clip id="([^"]+)">\s*<text>(.*?)</text>', request.user, flags=re.DOTALL
        )
    }


def is_judging(request: LlmRequest) -> bool:
    return "senior short-form video editor" in request.system


def is_copywriting(request: LlmRequest) -> bool:
    return "words that go with short video clips" in request.system
