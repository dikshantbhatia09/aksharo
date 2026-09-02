"""The model-server alignment rung, against A26's recorded `/align` response.

The recording in ``worker_ai/fixtures/vendor/gpu-whisper/session.json`` was
produced by driving ``apps/model-server``'s own test client, so these tests run
the real adapter against the real server's output. A26 reads the same file from
the other side (``tests/test_contract_fixtures.py``), which is what stops the two
apps drifting into separate ideas of one contract.
"""

from __future__ import annotations

import json
from itertools import pairwise
from typing import Any

import httpx2
import pytest

from worker_ai.alignment import AlignerRegistry, GpuCtcAligner
from worker_ai.evals.replay import load_session, replay_transport
from worker_ai.providers.base import AlignmentRequest, ProviderError
from worker_ai.providers.http import VendorHttp
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

WORDS = ("toh", "aaj", "hum", "baat", "karenge", "video", "editing", "ke", "baare", "mein")


def _aligner(fixture: str = "gpu-whisper") -> tuple[GpuCtcAligner, Any]:
    session = load_session(fixture)
    return (
        GpuCtcAligner(
            session.base_url,
            token="gpu-token",
            http=VendorHttp(
                provider="gpu-ctc",
                base_url=session.base_url,
                headers={"authorization": "Bearer gpu-token"},
                client=httpx2.AsyncClient(transport=replay_transport(session)),
            ),
        ),
        session,
    )


# ---------------------------------------------------------------------------
# The wire
# ---------------------------------------------------------------------------


async def test_it_sends_the_span_in_seconds_and_the_words_verbatim() -> None:
    aligner, session = _aligner()
    await aligner.align(
        AlignmentRequest(
            audio_uri="https://r2/audio.wav",
            words=WORDS,
            language="hi",
            start_ms=1_500,
            end_ms=5_500,
        )
    )

    request = next(item for item in session.seen if item.url.path == "/align")
    body = json.loads(request.content)
    assert body["words"] == list(WORDS)
    assert body["language"] == "hi"
    # Seconds on the wire, milliseconds in the worker.
    assert body["startS"] == 1.5
    assert body["endS"] == 5.5
    assert request.headers["authorization"] == "Bearer gpu-token"


async def test_the_span_end_is_omitted_when_the_caller_gave_none() -> None:
    aligner, session = _aligner()
    await aligner.align(
        AlignmentRequest(audio_uri="a.wav", words=WORDS, language="hi", start_ms=0)
    )
    body = json.loads(next(item for item in session.seen).content)
    assert "endS" not in body


async def test_words_come_back_in_file_time_and_are_not_shifted_twice() -> None:
    """The server adds ``startS`` itself; adding it again would double the offset."""
    aligner, _session = _aligner()
    words = await aligner.align(
        AlignmentRequest(audio_uri="a.wav", words=WORDS, language="hi", start_ms=0, end_ms=4_000)
    )
    assert [word.t for word in words] == list(WORDS)
    # The recording starts its first word at 0.0 s of file time.
    assert (words[0].s, words[0].e) == (0, 400)
    assert (words[-1].s, words[-1].e) == (3_600, 4_000)


async def test_the_caller_offset_is_the_only_shift_applied() -> None:
    aligner, _session = _aligner()
    words = await aligner.align(
        AlignmentRequest(
            audio_uri="a.wav", words=WORDS, language="hi", offset_ms=600_000, end_ms=4_000
        )
    )
    assert (words[0].s, words[0].e) == (600_000, 600_400)


async def test_probability_becomes_word_confidence() -> None:
    aligner, _session = _aligner()
    words = await aligner.align(
        AlignmentRequest(audio_uri="a.wav", words=WORDS, language="hi", end_ms=4_000)
    )
    assert words[0].c == 1.0


async def test_the_checkpoint_and_its_licence_are_recorded() -> None:
    """Which family answered is an `engineVersions` fact, and a licence one."""
    aligner, _session = _aligner()
    await aligner.align(
        AlignmentRequest(audio_uri="a.wav", words=WORDS, language="hi", end_ms=4_000)
    )
    assert aligner.last_model.startswith("ai4bharat/indicwav2vec")
    assert aligner.last_licence == "MIT"


async def test_every_call_is_a_submission_and_draining_clears_it() -> None:
    aligner, _session = _aligner()
    await aligner.align(
        AlignmentRequest(audio_uri="a.wav", words=WORDS, language="hi", end_ms=4_000)
    )
    drained = aligner.drain_submissions()
    assert len(drained) == 1
    wire = drained[0].to_wire()
    assert wire["provider"] == "gpu-ctc"
    assert wire["endpoint"].endswith("/align")
    assert wire["retentionClass"] == "ephemeral"
    assert wire["externalRef"]
    # The aligner outlives the job, so a second read must not repeat the first.
    assert aligner.drain_submissions() == ()


# ---------------------------------------------------------------------------
# Degraded and failure paths
# ---------------------------------------------------------------------------


async def test_a_word_outside_the_vocabulary_still_gets_a_span() -> None:
    """A26 returns one word per input word, giving a skipped one probability 0."""
    aligner, _session = _aligner("gpu-align-skipped")
    words = await aligner.align(
        AlignmentRequest(
            audio_uri="a.wav", words=("toh", "aaj", "hum"), language="hi", end_ms=1_200
        )
    )
    assert [word.t for word in words] == ["toh", "aaj", "hum"]
    assert words[1].c == 0.0
    # Every word keeps a monotonic, non-empty span despite the miss.
    for previous, following in pairwise(words):
        assert previous.s <= previous.e <= following.s


async def test_a_short_word_list_is_a_hard_failure() -> None:
    """The caller indexes by position; a missing timing is a shifted transcript."""

    async def handler(request: httpx2.Request) -> httpx2.Response:
        del request
        return httpx2.Response(
            200,
            json={
                "language": "hi",
                "model": "m",
                "licence": "MIT",
                "words": [{"start": 0.0, "end": 0.4, "word": "toh", "probability": 1.0}],
                "skipped": [],
            },
        )

    aligner = GpuCtcAligner(
        "https://gpu.test",
        http=VendorHttp(
            provider="gpu-ctc",
            base_url="https://gpu.test",
            client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        ),
    )
    with pytest.raises(ProviderError, match="1 timings for 3 words"):
        await aligner.align(
            AlignmentRequest(audio_uri="a.wav", words=("toh", "aaj", "hum"), language="hi")
        )


async def test_no_words_makes_no_call() -> None:
    aligner, session = _aligner()
    assert await aligner.align(AlignmentRequest(audio_uri="a.wav", words=(), language="hi")) == ()
    assert session.seen == []


async def test_alignment_without_audio_is_refused_rather_than_sent() -> None:
    aligner, session = _aligner()
    with pytest.raises(ProviderError, match="aligns audio"):
        await aligner.align(AlignmentRequest(audio_uri="", words=WORDS, language="hi"))
    assert session.seen == []


# ---------------------------------------------------------------------------
# Availability and the chain
# ---------------------------------------------------------------------------


def test_without_a_gpu_endpoint_it_says_so() -> None:
    assert "GPU_PROVIDER_URL" in str(GpuCtcAligner().available())
    assert GpuCtcAligner("https://gpu.test").available() is None


def test_a_flag_can_switch_it_off() -> None:
    assert "align.gpu" in str(GpuCtcAligner("https://gpu.test", enabled=False).available())


def test_it_sits_below_the_local_rungs_and_above_the_paid_one() -> None:
    """Local CTC costs a CPU pass; this costs GPU-seconds; ElevenLabs costs money."""
    names = [aligner.name for aligner in AlignerRegistry.default().chain("hi")]
    assert names == ["indicwav2vec-ctc", "gpu-ctc", "elevenlabs-fa", "proportional-vad"]
    assert [aligner.name for aligner in AlignerRegistry.default().chain("fr")] == [
        "xlsr53-ctc",
        "gpu-ctc",
        "elevenlabs-fa",
        "proportional-vad",
    ]


def test_it_covers_a_language_neither_local_family_claims() -> None:
    assert GpuCtcAligner().covers("sw") is True
    assert next(iter(AlignerRegistry.default().chain("sw"))).name == "gpu-ctc"


def test_a_gpu_deployment_resolves_to_it_without_any_local_weights() -> None:
    settings = load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.test"})
    registry = AlignerRegistry.from_settings(settings)
    assert registry.resolve("hi").name == "gpu-ctc"
    assert registry.resolve("sw").name == "gpu-ctc"
    # No endpoint and no weights still aligns, on the rung that needs neither.
    bare = AlignerRegistry.from_settings(load_settings(VALID_ENV))
    assert bare.resolve("hi").name == "proportional-vad"


def test_the_control_app_reports_the_rung_and_its_licences() -> None:
    settings = load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.test"})
    rows = {
        row["name"]: row for row in AlignerRegistry.from_settings(settings).describe("hi")
    }
    assert rows["gpu-ctc"]["available"] is True
    assert "Apache-2.0" in rows["gpu-ctc"]["licence"]
    assert "MIT" in rows["gpu-ctc"]["licence"]
