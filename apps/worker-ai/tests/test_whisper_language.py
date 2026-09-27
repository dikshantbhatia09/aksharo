"""Whisper takes a bare language code; the product's tags carry regions and scripts.

2026-09-27: a 35-minute English (India) video failed transcription because the
local Whisper adapter passed ``en-IN`` straight through and faster-whisper
refused it ("'en-IN' is not a valid language code") on every chunk.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

from worker_ai.languages import WHISPER_LANGUAGES, whisper_language
from worker_ai.providers import ServerlessWhisperProvider, TranscriptionRequest


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("en-IN", "en"),
        ("en", "en"),
        ("EN_us", "en"),
        ("pt-BR", "pt"),
        ("hi", "hi"),
        ("hi-IN", "hi"),
        ("hi-Latn", "hi"),
        ("hi-en", "hi"),
        ("hinglish", "hi"),
        ("ta-IN", "ta"),
        ("hin", "hi"),
    ],
)
def test_a_product_tag_becomes_the_bare_code_whisper_accepts(tag: str, expected: str) -> None:
    assert whisper_language(tag) == expected
    assert expected in WHISPER_LANGUAGES


@pytest.mark.parametrize("tag", [None, "", "und", "xx", "sat-IN", "mni"])
def test_no_language_or_one_whisper_does_not_know_means_detect(tag: str | None) -> None:
    assert whisper_language(tag) is None


async def test_the_serverless_endpoint_is_sent_the_bare_code() -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        seen["body"] = json.loads(request.content)
        return httpx2.Response(
            200,
            json={
                "language": "en",
                "durationS": 1.0,
                "words": [{"start": 0, "end": 0.4, "word": "hi"}],
            },
        )

    provider = ServerlessWhisperProvider(
        "https://gpu.invalid",
        token="t",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    await provider.transcribe(TranscriptionRequest(audio_uri="https://r2/a.wav", language="en-IN"))
    await provider.aclose()
    assert seen["body"]["language"] == "en"
