"""The three A10 vendor adapters, against recorded HTTP (`09 §1`, D12).

No vendor key exists yet (A00-06), so every test here drives the real adapter
through an ``httpx2.MockTransport`` serving the sessions recorded under
``worker_ai/fixtures/vendor``. What that proves is the half of an adapter that is
actually hard: the parsing, the unit conversion, the poll loop, the retry
classification and the submission trail.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx2
import pytest

from worker_ai.evals.replay import build_replay_provider, load_session, replay_transport
from worker_ai.providers.assemblyai import AssemblyAiProvider
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    ProviderError,
    TranscriptionRequest,
)
from worker_ai.providers.elevenlabs import (
    ELEVENLABS_INDIA_BASE_URL,
    ElevenLabsScribeProvider,
)
from worker_ai.providers.http import VendorHttp
from worker_ai.providers.sarvam import SARVAM_MODES, SarvamSaarasProvider


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    """A file on disk, because every vendor takes an upload rather than a URL."""
    path = tmp_path / "chunk-0000.wav"
    path.write_bytes(b"RIFF....WAVEfmt ")
    return path


# ---------------------------------------------------------------------------
# ElevenLabs Scribe v2
# ---------------------------------------------------------------------------


async def test_scribe_parses_words_drops_spacing_and_converts_seconds(audio: Path) -> None:
    provider, session = build_replay_provider("elevenlabs")
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), language="hi", offset_ms=600_000)
    )
    await provider.aclose()

    assert [word.t for word in result.words[:3]] == ["toh", "aaj", "hum"]
    # Seconds on the wire, milliseconds in the EDG, shifted into file time.
    assert (result.words[0].s, result.words[0].e) == (600_120, 600_440)
    # `spacing` and `audio_event` tokens are not words and must never be caption text.
    assert "(laughter)" not in [word.t for word in result.words]
    assert " " not in [word.t for word in result.words]
    # ISO-639-3 out, BCP-47 in.
    assert result.language == "hi"
    assert result.language_confidence == 0.97
    assert session.paths() == ["/v1/speech-to-text"]


async def test_scribe_maps_speaker_ids_onto_the_edg_numbering(audio: Path) -> None:
    provider, _session = build_replay_provider("elevenlabs")
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert {word.sp for word in result.words} == {"S1", "S2"}


async def test_scribe_sends_the_pipeline_form_fields(audio: Path) -> None:
    seen: dict[str, Any] = {}

    async def handler(request: httpx2.Request) -> httpx2.Response:
        seen["headers"] = dict(request.headers)
        seen["body"] = request.content.decode("utf-8", "replace")
        return httpx2.Response(
            200,
            json={
                "language_code": "hin",
                "words": [{"text": "toh", "start": 0.1, "end": 0.4, "type": "word"}],
            },
        )

    provider = ElevenLabsScribeProvider(
        "xi-not-real",
        base_url=ELEVENLABS_INDIA_BASE_URL,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), language="ta", hints=("Aksharo",))
    )
    await provider.aclose()

    assert seen["headers"]["xi-api-key"] == "xi-not-real"
    body = seen["body"]
    assert "scribe_v2" in body
    assert "timestamps_granularity" in body and "word" in body
    assert "tam" in body  # ISO-639-3 for the vendor
    assert "Aksharo" in body  # glossary hints as custom vocabulary (`09 §3`)
    assert "enable_logging" in body and "false" in body  # zero retention
    assert provider.region == "in"
    assert provider.retention_class == "zero-retention"


async def test_scribe_records_residency_and_retention_on_every_submission(
    audio: Path,
) -> None:
    """`06 §Invariant 5`: an erasure request has to be able to find the artefact."""
    provider, _session = build_replay_provider("elevenlabs")
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    submission = result.submissions[0].to_wire()
    assert submission["provider"] == "elevenlabs"
    assert submission["endpoint"].endswith("/v1/speech-to-text")
    assert submission["retentionClass"] == "zero-retention"
    assert submission["region"] == "global"


async def test_scribe_backs_off_a_429_then_succeeds(audio: Path) -> None:
    """Acceptance 1: 429 -> backoff -> success, without falling over."""
    session = load_session("elevenlabs-rate-limited")
    slept: list[float] = []

    async def sleep(delay: float) -> None:
        slept.append(delay)

    provider = ElevenLabsScribeProvider(
        "k",
        http=VendorHttp(
            provider="elevenlabs",
            base_url=session.base_url,
            headers={"xi-api-key": "k"},
            client=httpx2.AsyncClient(transport=replay_transport(session)),
            sleep=sleep,
        ),
    )
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()

    assert len(session.seen) == 2
    # `Retry-After: 0` was obeyed rather than the exponential default.
    assert slept == [0.0]
    assert result.words


async def test_scribe_does_not_retry_a_rejected_key(audio: Path) -> None:
    calls = 0

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        return httpx2.Response(401, json={"detail": "invalid api key"})

    provider = ElevenLabsScribeProvider(
        "bad", client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()

    assert calls == 1
    assert raised.value.retryable is False
    # THREAT-MODEL T21: the message names the failure, never the credential.
    assert "bad" not in str(raised.value)


async def test_scribe_forced_alignment_returns_word_timings(audio: Path) -> None:
    provider, session = build_replay_provider("elevenlabs", "elevenlabs-alignment")
    result = await provider.align(
        AlignmentRequest(
            audio_uri=str(audio),
            words=("toh", "aaj", "hum", "baat", "karenge"),
            language="hi",
            start_ms=1_000,
        )
    )
    await provider.aclose()
    assert result.words[0].t == "toh"
    assert result.words[0].s == 1_120
    assert session.paths() == ["/v1/forced-alignment"]


async def test_scribe_diarisation_collapses_words_into_turns(audio: Path) -> None:
    provider, _session = build_replay_provider("elevenlabs")
    turns = await provider.diarise(DiarisationRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert [turn.speaker_id for turn in turns] == ["S1", "S2"]
    assert turns[0].start_ms == 120
    assert turns[1].end_ms == 3_980


async def test_an_unreadable_chunk_is_not_retried(tmp_path: Path) -> None:
    provider, _session = build_replay_provider("elevenlabs")
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri=str(tmp_path / "gone.wav")))
    await provider.aclose()
    assert raised.value.retryable is False


# ---------------------------------------------------------------------------
# Sarvam Saaras v4 (Batch)
# ---------------------------------------------------------------------------


async def test_saaras_runs_the_whole_batch_flow_and_returns_segments(audio: Path) -> None:
    """RR-02 F1: init, upload, start, poll until Completed, download."""
    provider, session = build_replay_provider("sarvam")
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), options={"mode": "codemix", "api": "batch"})
    )
    await provider.aclose()

    assert [request.method for request in session.seen] == [
        "POST",  # create job
        "POST",  # upload-files: ask for a presigned PUT URL
        "PUT",  # upload the audio to that URL
        "POST",  # start
        "GET",  # status: Running
        "GET",  # status: Completed
        "POST",  # download-files: ask for a presigned GET URL
        "GET",  # download the transcript from that URL
    ]
    # No word timings: that is the whole reason the lane demands an aligner.
    assert result.words == ()
    assert result.segments == (
        (120, 2_100, "toh aaj hum baat karenge"),
        (2_200, 3_980, "video editing ke baare mein"),
    )
    assert result.language == "hi-IN"
    assert result.raw["alignmentRequired"] is True
    assert result.raw["mode"] == "codemix"


async def test_saaras_parses_the_parallel_timestamp_arrays_a_live_account_actually_sends(
    audio: Path,
) -> None:
    """This is not the fixture's shape -- it is a real, non-empty response,
    captured 2026-09-17 from a live `mode: codemix` call against audio already
    known (through this exact adapter) to transcribe correctly. `timestamps`
    is three parallel arrays, not a list of `{text, start_time_seconds,
    end_time_seconds}` objects, and the fixture/session.json's shape -- what
    every other test in this file replays -- was never actually confirmed
    against a codemix response. Getting this wrong is what silently collapsed
    every word's timing to (0, 0) in production while the transcript text
    stayed perfectly readable, which is exactly why it went unnoticed.
    """

    async def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/upload-files"):
            return httpx2.Response(
                200, json={"upload_urls": {"chunk-0000.wav": {"file_url": "https://blob.test/j"}}}
            )
        if request.url.path.endswith("/job/v1"):
            return httpx2.Response(200, json={"job_id": "j", "job_state": "Accepted"})
        if request.method == "PUT":
            return httpx2.Response(201)
        if request.url.path.endswith("/status"):
            return httpx2.Response(
                200,
                json={
                    "job_state": "Completed",
                    "job_details": [{"outputs": [{"file_name": "j.json"}]}],
                },
            )
        if request.url.path.endswith("/download-files"):
            return httpx2.Response(
                200, json={"download_urls": {"j.json": {"file_url": "https://blob.test/o.json"}}}
            )
        if request.url.path.endswith(".json"):
            return httpx2.Response(
                200,
                json={
                    "language_code": "en-IN",
                    "language_probability": 1.0,
                    "transcript": "Alright, so here we are, one of the uh elephants.",
                    "timestamps": {
                        "words": ["Alright, so here we are, one of the uh elephants."],
                        "start_time_seconds": [0.0],
                        "end_time_seconds": [19.07],
                    },
                    "diarized_transcript": None,
                },
            )
        return httpx2.Response(200, json={})

    provider = SarvamSaarasProvider(
        "k",
        base_url="https://api.sarvam.test",
        poll_interval_s=0.0,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()

    assert result.words == ()
    assert result.segments == (
        (0, 19_070, "Alright, so here we are, one of the uh elephants."),
    )
    assert result.language == "en-IN"


async def test_saaras_still_reads_the_object_list_shape_as_a_fallback(audio: Path) -> None:
    """Not proven wrong, only proven not to be what `mode: codemix` returns
    today (see the module docstring) -- kept in case some other mode or a
    future response genuinely uses it. Same fixture/session.json shape every
    other replay-based test in this file exercises, asserted directly here so
    a change that broke only this fallback would not hide behind the others.
    """
    provider, _session = build_replay_provider("sarvam")
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert result.segments == (
        (120, 2_100, "toh aaj hum baat karenge"),
        (2_200, 3_980, "video editing ke baare mein"),
    )


async def test_saaras_uploads_to_the_sas_container_keeping_the_token(audio: Path) -> None:
    provider, session = build_replay_provider("sarvam")
    await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()

    upload = next(request for request in session.seen if request.method == "PUT")
    assert upload.url.path.endswith("/job-1/chunk-0000.wav")
    assert "sig=replay" in str(upload.url)
    assert upload.headers["x-ms-blob-type"] == "BlockBlob"


async def test_saaras_sends_the_lane_mode_and_the_glossary(audio: Path) -> None:
    provider, session = build_replay_provider("sarvam")
    await provider.transcribe(
        TranscriptionRequest(
            audio_uri=str(audio), language="hi", hints=("Aksharo",), options={"mode": "verbatim"}
        )
    )
    await provider.aclose()

    create = next(
        request
        for request in session.seen
        if request.method == "POST" and request.url.path == "/speech-to-text/job/v1"
    )
    body = json.loads(create.content)
    assert body["job_parameters"]["mode"] == "verbatim"
    assert body["job_parameters"]["language_code"] == "hi-IN"
    assert body["job_parameters"]["with_timestamps"] is True
    # Diarisation is pyannote's job (D13), not a ₹0.25/min vendor uplift.
    assert body["job_parameters"]["with_diarization"] is False
    assert body["job_parameters"]["keyterms"] == ["Aksharo"]


async def test_saaras_auto_detects_for_the_code_mix_lane(audio: Path) -> None:
    provider, session = build_replay_provider("sarvam")
    await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), language="hi-en", options={"mode": "codemix"})
    )
    await provider.aclose()
    create = next(
        request
        for request in session.seen
        if request.method == "POST" and request.url.path == "/speech-to-text/job/v1"
    )
    assert json.loads(create.content)["job_parameters"]["language_code"] == "unknown"


async def test_saaras_refuses_a_mode_the_vendor_does_not_have(audio: Path) -> None:
    provider, _session = build_replay_provider("sarvam")
    with pytest.raises(ProviderError, match="unknown Saaras mode"):
        await provider.transcribe(
            TranscriptionRequest(audio_uri=str(audio), options={"mode": "karaoke"})
        )
    await provider.aclose()
    assert "codemix" in SARVAM_MODES


async def test_a_failed_saaras_job_is_not_retried(audio: Path) -> None:
    """A vendor that rejected this audio will reject it again; route on instead."""
    provider, _session = build_replay_provider("sarvam", "sarvam-failed")
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert raised.value.retryable is False
    assert "audio could not be decoded" in str(raised.value)


async def test_saaras_gives_up_on_a_job_that_never_finishes(audio: Path) -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/upload-files"):
            return httpx2.Response(
                200, json={"upload_urls": {"chunk-0000.wav": {"file_url": "https://blob.test/j"}}}
            )
        if request.url.path.endswith("/job/v1"):
            return httpx2.Response(200, json={"job_id": "j", "job_state": "Accepted"})
        if request.method == "PUT":
            return httpx2.Response(201)
        if request.url.path.endswith("/status"):
            return httpx2.Response(200, json={"job_state": "Running"})
        return httpx2.Response(200, json={})

    provider = SarvamSaarasProvider(
        "k",
        base_url="https://api.sarvam.test",
        poll_interval_s=1.0,
        poll_timeout_s=2.0,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    # A slow vendor is retryable: A08 decides whether there is another attempt.
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert raised.value.retryable is True


async def test_saaras_degrades_to_one_segment_when_only_a_transcript_comes_back(
    audio: Path,
) -> None:
    """A job that returned text is still usable — the aligner places the words."""
    async def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/upload-files"):
            return httpx2.Response(
                200, json={"upload_urls": {"chunk-0000.wav": {"file_url": "https://blob.test/j"}}}
            )
        if request.url.path.endswith("/job/v1"):
            return httpx2.Response(200, json={"job_id": "j", "job_state": "Accepted"})
        if request.method == "PUT":
            return httpx2.Response(201)
        if request.url.path.endswith("/status"):
            return httpx2.Response(
                200,
                json={
                    "job_state": "Completed",
                    "job_details": [{"outputs": [{"file_name": "j.json"}]}],
                },
            )
        if request.url.path.endswith("/download-files"):
            return httpx2.Response(
                200, json={"download_urls": {"j.json": {"file_url": "https://blob.test/o.json"}}}
            )
        if request.url.path.endswith(".json"):
            return httpx2.Response(
                200,
                json={
                    "language_code": "hi-IN",
                    "transcript": "toh aaj hum",
                    "duration_seconds": 3.0,
                },
            )
        return httpx2.Response(200, json={})

    provider = SarvamSaarasProvider(
        "k",
        base_url="https://api.sarvam.test",
        poll_interval_s=0.0,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert result.segments == ((0, 3_000, "toh aaj hum"),)


async def test_saaras_warns_when_a_chunk_has_no_recognised_timestamp_field(
    audio: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Found live 2026-09-16: real Hindi/Hinglish projects routed to Sarvam came
    back with correct text but every word's s/e exactly 0 -- ProportionalAligner
    collapses to (0, 0) the moment a chunk's span is zero-length, and a chunk
    with none of start_time_seconds/start_time/start is indistinguishable from
    one that legitimately answered 0.0. `start_time_seconds` was "verified live
    2026-09-14" (this module's docstring) against a plain request, not codemix
    -- this pins that a chunk shaped that way at least gets logged with its own
    keys, so the next occurrence arrives with real evidence instead of a guess.
    """

    async def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/upload-files"):
            return httpx2.Response(
                200, json={"upload_urls": {"chunk-0000.wav": {"file_url": "https://blob.test/j"}}}
            )
        if request.url.path.endswith("/job/v1"):
            return httpx2.Response(200, json={"job_id": "j", "job_state": "Accepted"})
        if request.method == "PUT":
            return httpx2.Response(201)
        if request.url.path.endswith("/status"):
            return httpx2.Response(
                200,
                json={
                    "job_state": "Completed",
                    "job_details": [{"outputs": [{"file_name": "j.json"}]}],
                },
            )
        if request.url.path.endswith("/download-files"):
            return httpx2.Response(
                200, json={"download_urls": {"j.json": {"file_url": "https://blob.test/o.json"}}}
            )
        if request.url.path.endswith(".json"):
            return httpx2.Response(
                200,
                json={
                    "language_code": "hi-IN",
                    "transcript": "toh aaj hum",
                    "timestamps": {
                        "chunks": [{"text": "toh aaj hum", "offset_seconds": 0.0, "dur": 2.1}]
                    },
                },
            )
        return httpx2.Response(200, json={})

    provider = SarvamSaarasProvider(
        "k",
        base_url="https://api.sarvam.test",
        poll_interval_s=0.0,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    with caplog.at_level("WARNING", logger="worker_ai.providers.sarvam"):
        result = await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()

    # The bug as it stands today: no recognised field means (0, 0), same as a
    # real zero-length chunk would. This test is not the fix for that -- it is
    # what makes the next occurrence diagnosable instead of silent.
    assert result.segments == ((0, 0, "toh aaj hum"),)
    warnings = [record for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "no recognised timestamp field" in warnings[0].getMessage()
    assert sorted(getattr(warnings[0], "chunkKeys", [])) == ["dur", "offset_seconds", "text"]


# ---------------------------------------------------------------------------
# AssemblyAI Universal-2
# ---------------------------------------------------------------------------


async def test_assemblyai_uploads_submits_and_polls(audio: Path) -> None:
    provider, session = build_replay_provider("assemblyai")
    result = await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), language="en-IN", offset_ms=1_000)
    )
    await provider.aclose()

    assert session.paths() == [
        "/v2/upload",
        "/v2/transcript",
        "/v2/transcript/tr-1",
        "/v2/transcript/tr-1",
    ]
    # AssemblyAI already speaks milliseconds; multiplying would be the bug.
    assert (result.words[0].s, result.words[0].e) == (1_120, 1_440)
    assert result.language == "en"
    assert result.usage is not None
    assert result.usage.media_seconds == 4.0
    assert result.submissions[0].external_ref == "tr-1"


async def test_assemblyai_passes_the_glossary_as_word_boost(audio: Path) -> None:
    provider, session = build_replay_provider("assemblyai")
    await provider.transcribe(
        TranscriptionRequest(audio_uri=str(audio), hints=("Aksharo", "EDG"))
    )
    await provider.aclose()
    submit = next(request for request in session.seen if request.url.path == "/v2/transcript")
    body = json.loads(submit.content)
    assert body["word_boost"] == ["Aksharo", "EDG"]
    assert body["speech_model"] == "universal-2"
    # No language pinned: ask the vendor to detect it.
    assert body["language_detection"] is True


async def test_assemblyai_maps_letter_speakers_onto_the_edg_numbering(audio: Path) -> None:
    provider, _session = build_replay_provider("assemblyai")
    turns = await provider.diarise(DiarisationRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert [turn.speaker_id for turn in turns] == ["S1", "S2"]


async def test_an_assemblyai_error_status_is_permanent(audio: Path) -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/v2/upload":
            return httpx2.Response(200, json={"upload_url": "https://cdn.test/x"})
        if request.url.path == "/v2/transcript":
            return httpx2.Response(200, json={"id": "t", "status": "queued"})
        return httpx2.Response(
            200, json={"status": "error", "error": "audio file is not decodable"}
        )

    provider = AssemblyAiProvider(
        "k",
        base_url="https://api.assemblyai.test",
        poll_interval_s=0.0,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    with pytest.raises(ProviderError) as raised:
        await provider.transcribe(TranscriptionRequest(audio_uri=str(audio)))
    await provider.aclose()
    assert raised.value.retryable is False
    assert "not decodable" in str(raised.value)


# ---------------------------------------------------------------------------
# The replay harness itself
# ---------------------------------------------------------------------------


def test_a_recorded_session_carries_no_credentials() -> None:
    """A fixture that leaked a key would leak it into every clone (T21)."""
    from worker_ai.evals.replay import VENDOR_FIXTURES_DIR

    for path in sorted(VENDOR_FIXTURES_DIR.glob("*/session.json")):
        body = path.read_text(encoding="utf-8")
        assert ".test" in body, path
        for marker in ("sk-", "xi-api-key:", "Bearer ey", "AKIA"):
            assert marker not in body, (path, marker)


def test_an_unrecorded_request_is_a_loud_failure() -> None:
    session = load_session("elevenlabs")
    response = session.handle(httpx2.Request("GET", "https://api.elevenlabs.test/v1/models"))
    assert response.status_code == 599
    assert "no recorded exchange" in response.json()["error"]


def test_a_missing_session_names_the_path(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="no recorded session"):
        load_session("nope", root=tmp_path)


def test_replay_refuses_a_provider_it_cannot_wire() -> None:
    with pytest.raises(ValueError, match="no replay wiring"):
        build_replay_provider("deepgram", "elevenlabs")
