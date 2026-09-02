"""The worker's own adapters, over a real socket, against this server.

Every other test in this suite drives the server with a client this repository
also wrote, which proves the server agrees with itself. This one imports
``apps/worker-ai``'s three clients — ``ServerlessWhisperProvider``,
``PyannoteCommunityDiariser`` and ``GpuLanguageIdentifier`` — points them at a
uvicorn actually listening on a loopback port, and asserts the values they parse
out. That is the only test that can fail when the two apps disagree.

``worker_ai`` is not installed into this app's virtual environment (it is a
different app with a different lock file); the sibling directory is put on
``sys.path`` instead, which works because the three clients import nothing but
``httpx2`` and the standard library. If the sibling is absent, the file skips.
"""

from __future__ import annotations

import socket
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn

from tests.conftest import TOKEN, build_app, build_settings, inline, make_wav

WORKER_AI_APP = Path(__file__).resolve().parents[2] / "worker-ai"

pytestmark = pytest.mark.skipif(
    not (WORKER_AI_APP / "worker_ai" / "providers" / "serverless_whisper.py").is_file(),
    reason="apps/worker-ai is not present next to this app",
)


@pytest.fixture(scope="module", autouse=True)
def _worker_ai_on_path() -> Iterator[None]:
    entry = str(WORKER_AI_APP)
    added = entry not in sys.path
    if added:
        sys.path.insert(0, entry)
    try:
        yield
    finally:
        if added and entry in sys.path:
            sys.path.remove(entry)


def _vendor_http(base_url: str) -> Any:
    """The worker's own HTTP client, injected so the test can close it."""
    from worker_ai.providers.http import VendorHttp

    return VendorHttp(
        provider="serverless-whisper",
        base_url=base_url,
        headers={"authorization": "Bearer " + TOKEN},
    )


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    """A real uvicorn on loopback, with the fake models behind it."""
    app = build_app(settings=build_settings(batch_max_size=4, batch_window_ms=25))
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="model-server-under-test", daemon=True)
    thread.start()
    deadline = threading.Event()
    while not server.started:
        if deadline.wait(0.05):  # pragma: no cover - never set; a bounded poll
            break
        if not thread.is_alive():  # pragma: no cover - uvicorn failed to bind
            raise RuntimeError("the model server did not start")
    try:
        yield "http://127.0.0.1:" + str(port)
    finally:
        server.should_exit = True
        thread.join(timeout=10)


async def test_serverless_whisper_provider_parses_a_live_transcript(base_url: str) -> None:
    from worker_ai.providers.base import TranscriptionRequest
    from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

    provider = ServerlessWhisperProvider(base_url, token=TOKEN)
    try:
        result = await provider.transcribe(
            TranscriptionRequest(
                audio_uri=inline(make_wav(4.0)),
                language="hi",
                word_timestamps=True,
            )
        )
    finally:
        await provider.aclose()

    assert result.language == "hi"
    assert result.language_confidence is not None
    # The adapter converts the wire's seconds into integer milliseconds; if this
    # server sent milliseconds, every timing would be a thousand times too large.
    assert result.words
    assert all(isinstance(word.s, int) and isinstance(word.e, int) for word in result.words)
    assert result.words[0].s >= 0
    assert result.words[-1].e <= 4_000
    starts = [word.s for word in result.words]
    assert starts == sorted(starts)
    assert result.usage.media_seconds == pytest.approx(4.0)
    assert result.usage.model == "large-v3-turbo"
    # The adapter records the request id from the response for the submission trail.
    assert result.submissions and result.submissions[0].external_ref


async def test_the_adapter_applies_its_chunk_offset(base_url: str) -> None:
    from worker_ai.providers.base import TranscriptionRequest
    from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

    provider = ServerlessWhisperProvider(base_url, token=TOKEN)
    try:
        result = await provider.transcribe(
            TranscriptionRequest(audio_uri=inline(make_wav(2.0)), offset_ms=600_000)
        )
    finally:
        await provider.aclose()
    assert result.words[0].s >= 600_000


async def test_a_bad_token_surfaces_as_a_non_retryable_provider_error(base_url: str) -> None:
    from worker_ai.providers.base import ProviderError, TranscriptionRequest
    from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

    provider = ServerlessWhisperProvider(base_url, token="wrong", max_attempts=1)
    try:
        with pytest.raises(ProviderError) as error:
            await provider.transcribe(TranscriptionRequest(audio_uri=inline(make_wav(1.0))))
    finally:
        await provider.aclose()
    assert error.value.retryable is False
    assert "401" in str(error.value)


async def test_the_pyannote_client_maps_speakers_and_milliseconds(base_url: str) -> None:
    from worker_ai.diarisation.pyannote import PyannoteCommunityDiariser
    from worker_ai.providers.base import DiarisationRequest

    http = _vendor_http(base_url)
    diariser = PyannoteCommunityDiariser(base_url, token=TOKEN, http=http)
    try:
        turns = await diariser.diarise(
            DiarisationRequest(audio_uri=inline(make_wav(4.0)), num_speakers=2)
        )
    finally:
        await http.aclose()
    # SPEAKER_00 becomes S1: pyannote's numbering never reaches a caption.
    assert [turn.speaker_id for turn in turns] == ["S1", "S2"]
    assert turns[0].start_ms == 0
    assert turns[-1].end_ms == 4_000
    assert diariser.drain_submissions()


async def test_the_gpu_language_identifier_reads_the_pooled_verdict(base_url: str) -> None:
    from worker_ai.lid import GpuLanguageIdentifier

    http = _vendor_http(base_url)
    identifier = GpuLanguageIdentifier(base_url, token=TOKEN, http=http)
    try:
        # The windows are milliseconds: the one field on this wire that is not
        # in seconds, because lid.py already sends it that way.
        signal = await identifier.identify(inline(make_wav(4.0)), ((0, 2000), (2000, 4000)))
    finally:
        await http.aclose()
    assert signal.source == "gpu"
    assert signal.language == "hi"
    assert signal.confidence == pytest.approx(0.88)


async def test_the_worker_never_sees_words_and_segments_disagree(base_url: str) -> None:
    """The adapter raises when a body has neither words nor segments; this has both."""
    from worker_ai.providers.base import TranscriptionRequest
    from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

    provider = ServerlessWhisperProvider(base_url, token=TOKEN)
    try:
        result = await provider.transcribe(TranscriptionRequest(audio_uri=inline(make_wav(3.0))))
    finally:
        await provider.aclose()
    assert result.words and result.segments
    assert result.segments[0][0] <= result.words[0].s
    assert result.segments[-1][1] >= result.words[-1].e - 1
