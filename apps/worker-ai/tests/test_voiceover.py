"""``ai.voiceover`` (2026-10-01): the contract mirror, the vendor client and the job.

Nothing here leaves the process: the vendor is ``httpx2.MockTransport`` and the
derived store an in-memory fake. What these tests hold to, above all: the
vendor is asked once per stored file, and an attempt that finds an earlier
attempt's file answers from it without calling the vendor again.
"""

from __future__ import annotations

import base64
import dataclasses
import io
import json
import re
import wave
from pathlib import Path
from typing import Any

import httpx2
import pytest
from pydantic import ValidationError

from worker_ai.callbacks import CallbackAck
from worker_ai.processors.context import JobContext, JobFailureError
from worker_ai.processors.voiceover import process_voiceover, wav_duration_ms
from worker_ai.queues import parse_envelope
from worker_ai.storage import ObjectStore
from worker_ai.voiceover.contracts import (
    VOICEOVER_KEY_PATTERN,
    VOICEOVER_LANGUAGES,
    VOICEOVER_SPEAKERS,
    VoiceoverCheckpoint,
    VoiceoverPayload,
    VoiceoverResult,
)
from worker_ai.voiceover.sarvam import SarvamSpeechClient, SpeechVendorError, vendor_paise

from .conftest import envelope
from .test_dub_processor import DubCallbacks
from .test_processors import build_services

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "packages" / "repurpose-contracts" / "fixtures"
VOICEOVER_TS = REPO_ROOT / "packages" / "repurpose-contracts" / "src" / "voiceover.ts"
PAYLOAD: dict[str, Any] = json.loads(
    (FIXTURES / "ai-voiceover-payload.v1.json").read_text(encoding="utf-8")
)
RESULT: dict[str, Any] = json.loads(
    (FIXTURES / "ai-voiceover-result.v1.json").read_text(encoding="utf-8")
)
KEY = str(PAYLOAD["destination"]["key"])
BASE = "https://api.sarvam.test"

# The same literals `packages/repurpose-contracts/src/voiceover.test.ts` asserts.
PAYLOAD_FIELDS = [
    "clipId",
    "destination",
    "language",
    "model",
    "pace",
    "runId",
    "schemaVersion",
    "speaker",
    "text",
    "voiceoverId",
]
RESULT_FIELDS = [
    "characters",
    "contentType",
    "durationMs",
    "key",
    "reused",
    "schemaVersion",
    "sizeBytes",
    "voiceoverId",
]
CHECKPOINT_FIELDS = ["characters", "durationMs", "key", "sizeBytes"]


def wav(duration_ms: int, rate: int = 22_050) -> bytes:
    """A real, silent mono 16-bit WAV of ``duration_ms``."""
    out = io.BytesIO()
    with wave.open(out, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\x00\x00" * round(rate * duration_ms / 1000))
    return out.getvalue()


async def _no_sleep(_seconds: float) -> None:
    return None


class FakeTts:
    """Sarvam's text-to-speech, scripted per test; counts every call."""

    def __init__(self, *, status: int = 200, audio: bytes | None = None) -> None:
        self.status = status
        self.audio = audio if audio is not None else wav(2_500)
        self.calls: list[dict[str, Any]] = []
        self.headers: list[httpx2.Headers] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        assert (request.method, request.url.path) == ("POST", "/text-to-speech")
        self.calls.append(json.loads(request.content))
        self.headers.append(request.headers)
        if self.status != 200:
            return httpx2.Response(self.status, json={"error": {"message": "text is too long"}})
        return httpx2.Response(
            200,
            json={"request_id": "req-1", "audios": [base64.b64encode(self.audio).decode()]},
        )


def speech_client(vendor: FakeTts) -> SarvamSpeechClient:
    return SarvamSpeechClient(
        "sk-test-not-a-real-key",
        base_url=BASE,
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(vendor)),
        sleep=_no_sleep,
    )


class MemoryS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        Path(Filename).write_bytes(self.objects[Key])

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        if Key not in self.objects:
            raise RuntimeError("NoSuchKey")
        return {"ContentLength": len(self.objects[Key])}

    def upload_file(self, Filename: str, Bucket: str, Key: str) -> None:  # noqa: N803
        self.objects[Key] = Path(Filename).read_bytes()


def harness(
    vendor: FakeTts | None,
    *,
    payload: dict[str, Any] | None = None,
    checkpoint: dict[str, Any] | None = None,
) -> tuple[JobContext, DubCallbacks, MemoryS3]:
    s3 = MemoryS3()
    callbacks = DubCallbacks()
    services = dataclasses.replace(
        build_services(store=ObjectStore(bucket="derived", client=s3)),
        callbacks=callbacks,
        speech=None if vendor is None else speech_client(vendor),
    )
    context = JobContext(
        envelope=parse_envelope(envelope(**(payload or PAYLOAD))),
        queue="ai.voiceover",
        services=services,
        max_attempts=2,
    )
    if checkpoint is not None:
        context.start_ack = CallbackAck(
            applied=True, job_id="j", status="running", checkpoint=checkpoint
        )
    return context, callbacks, s3


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_parses_the_shared_fixtures() -> None:
    assert VoiceoverPayload.model_validate(PAYLOAD).voiceover_id == PAYLOAD["voiceoverId"]
    assert VoiceoverResult.model_validate(RESULT).duration_ms == 3000


def test_names_the_same_fields_as_the_typescript_contract() -> None:
    def aliases(model: type[Any]) -> list[str]:
        return sorted(field.alias or name for name, field in model.model_fields.items())

    assert aliases(VoiceoverPayload) == PAYLOAD_FIELDS
    assert aliases(VoiceoverResult) == RESULT_FIELDS
    assert aliases(VoiceoverCheckpoint) == CHECKPOINT_FIELDS


def test_key_pattern_languages_and_voices_match_the_typescript_source() -> None:
    source = VOICEOVER_TS.read_text(encoding="utf-8")
    ts_pattern = re.search(r"VOICEOVER_KEY_PATTERN =\s*\n?\s*/(.+)/;", source)
    assert ts_pattern is not None
    assert ts_pattern.group(1).replace("\\/", "/") == VOICEOVER_KEY_PATTERN
    for code in VOICEOVER_LANGUAGES:
        assert f'"{code}"' in source
    for speaker in VOICEOVER_SPEAKERS:
        assert f'"{speaker}"' in source


@pytest.mark.parametrize(
    "change",
    [
        {"extra": 1},
        {"text": " "},
        {"text": "a" * 301},
        {"pace": 2},
        {"speaker": "meera"},
        {"language": "or-IN"},
        {"model": "bulbul:v1"},
        {"destination": {"key": KEY.replace("hook.wav", "../hook.wav")}},
        {"destination": {"key": KEY.replace("/voiceovers/", "/dubs/")}},
    ],
)
def test_refuses_what_the_typescript_side_refuses(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        VoiceoverPayload.model_validate({**PAYLOAD, **change})


# ---------------------------------------------------------------------------
# The vendor client
# ---------------------------------------------------------------------------


async def test_sends_the_hook_with_the_key_and_decodes_the_wav() -> None:
    vendor = FakeTts()
    speech = await speech_client(vendor).synthesise(
        text="Nobody tells you this",
        language="hi-IN",
        speaker="anushka",
        pace=1.0,
        model="bulbul:v2",
        sample_rate=22_050,
    )
    assert speech.audio == vendor.audio
    assert speech.request_id == "req-1"
    assert vendor.headers[0]["api-subscription-key"] == "sk-test-not-a-real-key"
    assert vendor.calls[0] == {
        "text": "Nobody tells you this",
        "target_language_code": "hi-IN",
        "speaker": "anushka",
        "pace": 1.0,
        "model": "bulbul:v2",
        "speech_sample_rate": 22_050,
        "enable_preprocessing": True,
    }


async def test_a_refusal_is_the_vendors_words_and_not_retried() -> None:
    vendor = FakeTts(status=400)
    with pytest.raises(SpeechVendorError) as caught:
        await speech_client(vendor).synthesise(
            text="x" * 10,
            language="hi-IN",
            speaker="anushka",
            pace=1.0,
            model="bulbul:v2",
            sample_rate=22_050,
        )
    assert caught.value.code == "voiceover/vendor_refused"
    assert caught.value.message == "text is too long"
    assert caught.value.retryable is False
    assert len(vendor.calls) == 1


async def test_a_bad_key_and_an_outage_are_told_apart() -> None:
    for status, code, retryable, calls in (
        (401, "voiceover/vendor_auth", False, 1),
        (503, "voiceover/vendor_unavailable", True, 3),
    ):
        vendor = FakeTts(status=status)
        with pytest.raises(SpeechVendorError) as caught:
            await speech_client(vendor).synthesise(
                text="hello there",
                language="en-IN",
                speaker="karun",
                pace=1.0,
                model="bulbul:v2",
                sample_rate=22_050,
            )
        assert (caught.value.code, caught.value.retryable, len(vendor.calls)) == (
            code,
            retryable,
            calls,
        )
        assert "sk-test" not in caught.value.message


def test_prices_a_hook_in_paise_rounded_up() -> None:
    # ₹15 per 10,000 characters.
    assert vendor_paise(46) == 7
    assert vendor_paise(300) == 45
    assert vendor_paise(0) == 0


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------


async def test_makes_stores_and_records_one_voice_over() -> None:
    vendor = FakeTts(audio=wav(2_500))
    context, callbacks, s3 = harness(vendor)

    outcome = await process_voiceover(context)
    context.cleanup()

    result = VoiceoverResult.model_validate(outcome.result)
    assert result.key == KEY
    assert result.duration_ms == 2_500
    assert result.reused is False
    assert result.characters == len(PAYLOAD["text"])
    assert s3.objects[KEY] == vendor.audio
    assert callbacks.checkpoints == [
        {
            "key": KEY,
            "sizeBytes": len(vendor.audio),
            "durationMs": 2_500,
            "characters": len(PAYLOAD["text"]),
        }
    ]
    assert len(vendor.calls) == 1
    assert outcome.usage is not None
    assert outcome.usage.cost_minor == vendor_paise(len(PAYLOAD["text"]))


async def test_a_retry_answers_from_the_stored_file_without_the_vendor() -> None:
    vendor = FakeTts()
    stored = wav(1_800)
    point = {
        "key": KEY,
        "sizeBytes": len(stored),
        "durationMs": 1_800,
        "characters": len(PAYLOAD["text"]),
    }
    context, _, s3 = harness(vendor, checkpoint=point)
    s3.objects[KEY] = stored

    result = VoiceoverResult.model_validate((await process_voiceover(context)).result)

    assert result.reused is True
    assert result.duration_ms == 1_800
    assert vendor.calls == []


async def test_a_checkpoint_whose_file_is_gone_is_made_again() -> None:
    vendor = FakeTts()
    point = {"key": KEY, "sizeBytes": 999, "durationMs": 1_000, "characters": 10}
    context, _, _ = harness(vendor, checkpoint=point)

    result = VoiceoverResult.model_validate((await process_voiceover(context)).result)

    assert result.reused is False
    assert len(vendor.calls) == 1


async def test_something_that_is_not_a_wav_is_never_filed() -> None:
    vendor = FakeTts(audio=b"<html>nope</html>")
    context, _, s3 = harness(vendor)
    with pytest.raises(JobFailureError) as caught:
        await process_voiceover(context)
    assert caught.value.code == "voiceover/unreadable"
    assert caught.value.retryable is True
    assert s3.objects == {}


async def test_a_runaway_voice_is_refused() -> None:
    vendor = FakeTts(audio=wav(31_000, rate=8_000))
    context, _, s3 = harness(vendor)
    with pytest.raises(JobFailureError) as caught:
        await process_voiceover(context)
    assert caught.value.code == "voiceover/too_long"
    assert s3.objects == {}


async def test_without_a_key_nothing_is_spent() -> None:
    context, _, _ = harness(None)
    with pytest.raises(JobFailureError) as caught:
        await process_voiceover(context)
    assert caught.value.code == "voiceover/not_configured"
    assert caught.value.retryable is False


async def test_a_payload_pointing_elsewhere_is_refused_before_the_vendor() -> None:
    vendor = FakeTts()
    bad = {**PAYLOAD, "destination": {"key": KEY.replace("/voiceovers/", "/clips/")}}
    context, _, _ = harness(vendor, payload=bad)
    with pytest.raises(JobFailureError) as caught:
        await process_voiceover(context)
    assert caught.value.code == "worker/invalid_payload"
    assert vendor.calls == []


def test_wav_duration_reads_the_header() -> None:
    assert wav_duration_ms(wav(1_000)) == 1_000
    assert wav_duration_ms(b"RIFF\x00\x00\x00\x00WAVEjunk") is None
    assert wav_duration_ms(b"ID3....") is None
