"""The manual smoke path for the day the vendor keys arrive (A00-06).

**Nothing here runs without `RUN_VENDOR_SMOKE=1` and a real key**, and nothing in
CI ever sets either. These tests exist so that "check the adapters against the
real vendors" is a command rather than a paragraph, and so that the first thing
anyone does with a new key is the thing that catches a wrong field name:

```bash
export ELEVENLABS_API_KEY=... SARVAM_API_KEY=... ASSEMBLYAI_API_KEY=...
export RUN_VENDOR_SMOKE=1
python -m pytest tests/test_vendor_smoke.py -v
```

Each test spends a few paise on five seconds of audio and asserts only the
contract — words in milliseconds inside the clip, a language, a usage record and
a submission trail. If one fails, the module docstring of the adapter it names
states the wire contract that was assumed and is the one place to correct.

The clip sent is ``worker_ai/fixtures/speech-5s/clip.wav``: CC0, synthetic, and
not a recording of anybody, so a smoke run sends no one's voice to a vendor
before the DPAs are signed.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from worker_ai.providers.base import Provider, TranscriptionRequest
from worker_ai.providers.registry import build_registry
from worker_ai.settings import load_repo_dotenv, load_settings

CLIP = Path(__file__).resolve().parents[1] / "worker_ai" / "fixtures" / "speech-5s" / "clip.wav"

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_VENDOR_SMOKE") != "1",
    reason="calls a real vendor and spends real money; set RUN_VENDOR_SMOKE=1",
)


async def _provider(name: str) -> AsyncIterator[Provider]:
    # Deliberately reads the real environment: this file only runs when a human
    # exported real keys and set RUN_VENDOR_SMOKE=1, which is the whole point.
    load_repo_dotenv()
    registry = build_registry(load_settings())
    reason = registry.reason_disabled(name)
    if reason is not None:
        pytest.skip(f"{name} is not configured here: {reason}")
    provider = await registry.get(name)
    try:
        yield provider
    finally:
        await registry.aclose()


@pytest.mark.parametrize("name", ["elevenlabs", "sarvam", "assemblyai", "serverless-whisper"])
async def test_a_vendor_returns_the_shape_the_adapter_expects(name: str) -> None:
    async for provider in _provider(name):
        result = await provider.transcribe(
            TranscriptionRequest(
                audio_uri=str(CLIP),
                language=None,
                hints=("Aksharo",),
                offset_ms=0,
                options={"mode": "codemix"} if name == "sarvam" else {},
            )
        )

        assert result.language, "every adapter must report a language"
        assert result.usage is not None
        assert result.usage.provider == name
        assert result.usage.cost_minor is not None
        assert result.submissions, "every external call is a provider_submission"

        if provider.capabilities.word_timestamps:
            assert result.words, "this vendor is routed *because* it gives word timings"
            for word in result.words:
                assert 0 <= word.s <= word.e <= 6_000, (word.s, word.e, word.t)
        else:
            # Sarvam: chunk-level only, which is why its lane demands an aligner.
            assert result.segments
            assert result.words == ()


async def test_scribe_forced_alignment_agrees_with_the_words_it_is_given() -> None:
    from worker_ai.providers.base import AlignmentRequest

    async for provider in _provider("elevenlabs"):
        words = ("toh", "aaj", "hum")
        result = await provider.align(
            AlignmentRequest(audio_uri=str(CLIP), words=words, language="hi")
        )
        assert len(result.words) == len(words)


async def test_the_india_residency_endpoint_answers() -> None:
    """`09 §8` and D17: Indian production media must not leave the region."""
    from worker_ai.providers.elevenlabs import ELEVENLABS_INDIA_BASE_URL, ElevenLabsScribeProvider

    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        pytest.skip("ELEVENLABS_API_KEY is not set")
    provider = ElevenLabsScribeProvider(key, base_url=ELEVENLABS_INDIA_BASE_URL)
    try:
        result = await provider.transcribe(TranscriptionRequest(audio_uri=str(CLIP)))
    finally:
        await provider.aclose()
    assert provider.region == "in"
    assert result.submissions[0].region == "in"
    assert result.submissions[0].retention_class == "zero-retention"
