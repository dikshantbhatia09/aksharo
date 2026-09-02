"""The fake/mock provider: no network, no key (brief section 6, LLM_PROVIDER=mock).

Builds a schema-valid JSON reply deterministically from the transcript itself —
the same approach as ``packages/prompts/src/eval/mock-provider.ts`` — which is
what makes it safe to run in CI and against real fixtures without a vendor key,
and exercises the hallucination guard meaningfully (everything it emits is
lifted from the transcript's own words).
"""

from __future__ import annotations

import json
from typing import Any

from worker_ai.llm.providers.base import LlmProvider, LlmRequest, LlmResponse, LlmUsage
from worker_ai.llm.templates import (
    TranscriptInput,
    max_chapters_for,
)

__all__ = ["MockLlmProvider"]


def _clip(text: str, max_len: int) -> str:
    text = text.strip()
    return text if len(text) <= max_len else (text[: max_len - 1].rstrip() + "…")


class MockLlmProvider(LlmProvider):
    name = "mock"
    #: The mock never leaves the process, so every region is "compliant".
    supported_regions = frozenset({"in", "eu", "us"})
    no_training = True

    def __init__(self, transcript: TranscriptInput | None = None, kind: str = "chapters") -> None:
        # The mock is driven by the caller re-supplying the transcript/kind via
        # `generate_for`; `generate()` alone (the LlmProvider contract) cannot
        # invent transcript-grounded content from a rendered prompt string, so
        # `service.py` calls `generate_for` directly when provider.name == "mock".
        self._transcript = transcript
        self._kind = kind

    async def generate(self, request: LlmRequest) -> LlmResponse:
        # Fallback used only if something calls the generic interface directly
        # without going through `generate_for` — returns an empty-but-valid
        # payload shape per kind so schema validation still has something to work with.
        return LlmResponse(text="{}", usage=LlmUsage(), endpoint="mock://local")

    def generate_for(self, kind: str, transcript: TranscriptInput) -> LlmResponse:
        if kind == "chapters":
            payload = self._chapters(transcript)
        elif kind == "summary":
            payload = self._summary(transcript)
        elif kind == "hooks":
            payload = self._hooks(transcript)
        else:
            raise ValueError(f"mock provider has no generator for kind={kind!r}")
        usage = LlmUsage(input_tokens=100, output_tokens=100)
        return LlmResponse(text=json.dumps(payload), usage=usage, endpoint="mock://local")

    def _chapters(self, transcript: TranscriptInput) -> dict[str, Any]:
        cap = min(max_chapters_for(transcript.duration_ms), len(transcript.segments))
        cap = max(cap, 1)
        stride = max(1, len(transcript.segments) // cap)
        chapters: list[dict[str, Any]] = []
        for i, segment in enumerate(transcript.segments):
            if len(chapters) >= cap:
                break
            if i % stride != 0:
                continue
            title = segment.text or f"Chapter {len(chapters) + 1}"
            chapters.append({"startMs": segment.start_ms, "title": _clip(title, 60)})
        if not chapters and transcript.segments:
            first = transcript.segments[0]
            chapters.append({"startMs": first.start_ms, "title": _clip(first.text, 60)})
        return {"chapters": chapters}

    def _summary(self, transcript: TranscriptInput) -> dict[str, Any]:
        full = " ".join(segment.text for segment in transcript.segments)
        return {
            "short": _clip(full, 240),
            "medium": _clip(full, 600),
            "long": _clip(full, 1_200),
        }

    def _hooks(self, transcript: TranscriptInput) -> dict[str, Any]:
        from worker_ai.llm.templates import transcript_vocabulary

        vocab = [w for w in transcript_vocabulary(transcript) if len(w) > 1]
        words = vocab or ["clip"]

        def pick(n: int) -> str:
            return words[n % len(words)]

        result = {}
        for platform in ("youtube", "instagram", "tiktok"):
            hooks = [_clip(f"{pick(i)} {pick(i + 1)} {pick(i + 2)}", 120) for i in range(5)]
            titles = [_clip(f"{pick(i + 3)} {pick(i + 4)}", 100) for i in range(5)]
            hashtags = []
            for i in range(10):
                tag = "".join(ch for ch in pick(i + 5) if ch.isalnum() or ch == "_")
                hashtags.append(f"#{tag}" if tag else f"#tag{i}")
            result[platform] = {"hooks": hooks, "titles": titles, "hashtags": hashtags}
        return result
