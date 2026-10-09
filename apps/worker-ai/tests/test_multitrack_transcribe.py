"""Tests for multi-track audio demuxing and speaker channel separation in ``ai.transcribe``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from worker_ai.audio import write_wav
from worker_ai.processors import JobFailureError, process_transcribe
from worker_ai.providers.base import (
    ProviderCapabilities,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

from .conftest import MEDIA_ID, clip
from .test_transcribe_pipeline import FakeProvider, context, services_with


class TrackAwareFakeProvider(FakeProvider):
    """A fake provider that returns distinct words depending on the audio request offset."""

    def __init__(self, name: str, *, track_words_map: dict[str, tuple[str, ...]]) -> None:
        super().__init__(name)
        self.track_words_map = track_words_map
        self.call_count = 0

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self.calls.append(request)
        self.call_count += 1
        words_list = ("hello", "world")
        for key, val in self.track_words_map.items():
            if key in request.audio_uri:
                words_list = val
                break
        else:
            words_list = self.track_words_map.get(str(self.call_count), ("default", "words"))

        words = tuple(
            Word(
                s=request.offset_ms + index * 400,
                e=request.offset_ms + index * 400 + 350,
                t=text,
            )
            for index, text in enumerate(words_list)
        )
        return TranscriptionResult(
            words=words,
            language="en",
            language_confidence=0.98,
            usage=ProviderUsage(media_seconds=3.0, provider=self.name, model="fake", cost_minor=5),
            submissions=(
                ProviderSubmission(provider=self.name, endpoint="https://fake", artefact="track.wav"),
            ),
        )


async def test_multitrack_transcribe_two_dialogue_tracks(tmp_path: Path) -> None:
    """Multi-track demuxing transcribes Host & Guest tracks and attributes speakers."""
    track1_wav = write_wav(tmp_path / "host.wav", clip(("speech", 2000), ("silence", 500)))
    track2_wav = write_wav(tmp_path / "guest.wav", clip(("silence", 2000), ("speech", 2000)))

    provider = TrackAwareFakeProvider(
        "serverless-whisper",
        track_words_map={
            "host.wav": ("welcome", "everyone"),
            "guest.wav": ("thank", "you"),
        },
    )
    services = services_with({"serverless-whisper": provider})

    job_context = context(
        services,
        mediaId=MEDIA_ID,
        language="en",
        audioTracks=[
            {
                "id": "trk_host",
                "label": "Host Mic",
                "speakerLabel": "Host",
                "isDialogue": True,
                "audioUri": str(track1_wav),
            },
            {
                "id": "trk_guest",
                "label": "Guest Mic",
                "speakerLabel": "Guest",
                "isDialogue": True,
                "audioUri": str(track2_wav),
            },
        ],
    )

    outcome = await process_transcribe(job_context)
    result = outcome.result

    # Diarisation metadata
    assert "diarisation" in result
    diarisation = result["diarisation"]
    assert diarisation["diariser"] == "multitrack-demux"
    speaker_ids = [s["id"] for s in diarisation["speakers"]]
    assert "Host" in speaker_ids
    assert "Guest" in speaker_ids

    # Words check
    all_words = [w for chunk in result["chunks"] for w in chunk["words"]]
    assert len(all_words) == 4

    host_words = [w for w in all_words if w.get("sp") == "Host"]
    guest_words = [w for w in all_words if w.get("sp") == "Guest"]

    assert [w["t"] for w in host_words] == ["welcome", "everyone"]
    assert [w["t"] for w in guest_words] == ["thank", "you"]


async def test_multitrack_filters_non_dialogue_tracks(tmp_path: Path) -> None:
    """Non-dialogue tracks (e.g. game audio / desktop sound) are ignored."""
    dialogue_wav = write_wav(tmp_path / "mic.wav", clip(("speech", 2000), ("silence", 500)))
    game_wav = write_wav(tmp_path / "game.wav", clip(("speech", 2000), ("silence", 500)))

    provider = TrackAwareFakeProvider(
        "serverless-whisper",
        track_words_map={
            "mic.wav": ("gameplay", "commentary"),
            "game.wav": ("boom", "crash"),
        },
    )
    services = services_with({"serverless-whisper": provider})

    job_context = context(
        services,
        mediaId=MEDIA_ID,
        language="en",
        audioTracks=[
            {
                "id": "trk_mic",
                "label": "Gamer Mic",
                "speakerLabel": "Player1",
                "isDialogue": True,
                "audioUri": str(dialogue_wav),
            },
            {
                "id": "trk_game",
                "label": "Game Audio",
                "isDialogue": False,
                "audioUri": str(game_wav),
            },
        ],
    )

    outcome = await process_transcribe(job_context)
    result = outcome.result

    all_words = [w for chunk in result["chunks"] for w in chunk["words"]]
    assert [w["t"] for w in all_words] == ["gameplay", "commentary"]
    assert all(w.get("sp") == "Player1" for w in all_words)
    # Ensure game audio was never transcribed
    assert not any("game.wav" in req.audio_uri for req in provider.calls)


async def test_multitrack_skips_silent_channel(tmp_path: Path) -> None:
    """Silent tracks do not cause failure and are gracefully skipped."""
    speech_wav = write_wav(tmp_path / "active.wav", clip(("speech", 2000), ("silence", 500)))
    silent_wav = write_wav(tmp_path / "silent.wav", clip(("silence", 2500)))

    provider = TrackAwareFakeProvider(
        "serverless-whisper",
        track_words_map={
            "active.wav": ("speech", "heard"),
        },
    )
    services = services_with({"serverless-whisper": provider})

    job_context = context(
        services,
        mediaId=MEDIA_ID,
        language="en",
        audioTracks=[
            {
                "id": "trk_active",
                "label": "Active Mic",
                "speakerLabel": "Host",
                "isDialogue": True,
                "audioUri": str(speech_wav),
            },
            {
                "id": "trk_silent",
                "label": "Silent Mic",
                "speakerLabel": "Guest",
                "isDialogue": True,
                "audioUri": str(silent_wav),
            },
        ],
    )

    outcome = await process_transcribe(job_context)
    result = outcome.result

    all_words = [w for chunk in result["chunks"] for w in chunk["words"]]
    assert [w["t"] for w in all_words] == ["speech", "heard"]
    assert all(w.get("sp") == "Host" for w in all_words)


async def test_multitrack_all_silent_fails_cleanly(tmp_path: Path) -> None:
    """If all dialogue tracks are empty/silent, raises empty_media failure."""
    silent1_wav = write_wav(tmp_path / "silent1.wav", clip(("silence", 2000)))
    silent2_wav = write_wav(tmp_path / "silent2.wav", clip(("silence", 2000)))

    provider = TrackAwareFakeProvider("serverless-whisper", track_words_map={})
    services = services_with({"serverless-whisper": provider})

    job_context = context(
        services,
        mediaId=MEDIA_ID,
        language="en",
        audioTracks=[
            {
                "id": "trk_1",
                "label": "Mic 1",
                "isDialogue": True,
                "audioUri": str(silent1_wav),
            },
            {
                "id": "trk_2",
                "label": "Mic 2",
                "isDialogue": True,
                "audioUri": str(silent2_wav),
            },
        ],
    )

    with pytest.raises(JobFailureError) as exc_info:
        await process_transcribe(job_context)

    assert exc_info.value.code == "worker/empty_media"

