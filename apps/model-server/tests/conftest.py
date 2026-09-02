"""Fakes and fixtures.

The fakes implement the same three ABCs the real backends do, so a route test
exercises the *real* route — real auth, real batching, real memory guard, real
serialisation — with only the model replaced. The one test that loads a real
model (``test_cpu_end_to_end.py``) is what keeps the fakes honest about the
interface.
"""

from __future__ import annotations

import base64
import io
import math
import os
import struct
import threading
import wave
from collections.abc import Iterator, Sequence
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from model_server.app import create_app
from model_server.metrics import Metrics
from model_server.models.base import (
    AlignerBackend,
    AlignJob,
    AlignOutput,
    AsrBackend,
    DetectJob,
    DiariseJob,
    DiariserBackend,
    LanguageVerdict,
    SegmentTiming,
    SpeakerTurn,
    TranscribeJob,
    TranscribeOutput,
    WordTiming,
)
from model_server.models.diariser import PYANNOTE_ATTRIBUTION, PYANNOTE_LICENCE, PYANNOTE_MODEL
from model_server.models.registry import ModelRegistry
from model_server.settings import Settings

TOKEN = "test-gpu-token"

#: The worker's recorded session — the wire contract this server must satisfy.
WORKER_AI = Path(__file__).resolve().parents[2] / "worker-ai" / "worker_ai"
GPU_FIXTURE = WORKER_AI / "fixtures" / "vendor" / "gpu-whisper" / "session.json"
SPEECH_CLIP = WORKER_AI / "fixtures" / "speech-5s" / "clip.wav"

#: The words A10's fixture records, so a fake can return the same transcript.
FIXTURE_WORDS = (
    "toh",
    "aaj",
    "hum",
    "baat",
    "karenge",
    "video",
    "editing",
    "ke",
    "baare",
    "mein",
)


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------


def make_wav(seconds: float = 1.0, *, rate: int = 16_000, freq: float = 220.0) -> bytes:
    """A tiny 16-bit mono PCM WAV, deterministic, with no external file."""
    count = int(seconds * rate)
    frames = b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * index / rate)))
        for index in range(count)
    )
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(frames)
    return buffer.getvalue()


def inline(payload: bytes) -> str:
    """A WAV as the ``data:`` URI the wire accepts."""
    return "data:audio/wav;base64," + base64.b64encode(payload).decode("ascii")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeAsr(AsrBackend):
    """Deterministic transcripts, and a record of how it was batched."""

    kind = "asr"
    model_id = "large-v3-turbo"
    licence = "MIT"

    def __init__(self, *, delay_s: float = 0.0, fail: bool = False) -> None:
        self.delay_s = delay_s
        self.fail = fail
        #: One entry per call: how many jobs the batcher handed over.
        self.batch_sizes: list[int] = []
        self.calls = 0
        #: Set the instant a model call begins, so a test can wait for it rather
        #: than sleep and hope.
        self.entered = threading.Event()
        self._lock = threading.Lock()

    def load(self) -> None:
        self._ready = True

    def transcribe(self, jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        with self._lock:
            self.calls += 1
            self.batch_sizes.append(len(jobs))
        self.entered.set()
        if self.fail:
            raise RuntimeError("the fake ASR was told to fail")
        if self.delay_s:
            import time

            time.sleep(self.delay_s)
        return [self._one(job) for job in jobs]

    def _one(self, job: TranscribeJob) -> TranscribeOutput:
        duration = len(job.samples) / job.sample_rate if job.sample_rate else 0.0
        step = duration / max(1, len(FIXTURE_WORDS))
        words = tuple(
            WordTiming(
                start=round(index * step, 3),
                end=round((index + 1) * step, 3),
                word=word,
                probability=0.9,
            )
            for index, word in enumerate(FIXTURE_WORDS)
        )
        return TranscribeOutput(
            language=job.language or "hi",
            language_probability=0.91,
            duration_s=round(duration, 3),
            words=words,
            segments=(
                SegmentTiming(start=0.0, end=round(duration, 3), text=" ".join(FIXTURE_WORDS)),
            ),
        )

    def detect_language(self, job: DetectJob) -> list[LanguageVerdict]:
        total_ms = round(1000 * len(job.samples) / (job.sample_rate or 16_000))
        windows = job.windows or ((0, min(total_ms, 30_000)),)
        return [
            LanguageVerdict(language="hi", probability=0.88, start_ms=start, end_ms=end)
            for start, end in windows
        ]


class FakeAligner(AlignerBackend):
    """Even spacing across the span; enough to prove the wire and the guard."""

    kind = "align"
    model_id = "ai4bharat/indicwav2vec/hi"
    licence = "MIT"

    def __init__(self, *, missing_for: tuple[str, ...] = ()) -> None:
        self.missing_for = missing_for

    def load(self) -> None:
        self._ready = True

    def unavailable_for(self, language: str) -> str | None:
        if language in self.missing_for:
            return "no checkpoint for " + language
        return None

    def align(self, job: AlignJob) -> AlignOutput:
        duration = len(job.samples) / job.sample_rate if job.sample_rate else 0.0
        step = duration / max(1, len(job.words))
        words = tuple(
            WordTiming(
                start=round(job.start_s + index * step, 3),
                end=round(job.start_s + (index + 1) * step, 3),
                word=word,
                probability=1.0,
            )
            for index, word in enumerate(job.words)
        )
        return AlignOutput(words=words, model_id=self.model_id, licence=self.licence)


class FakeDiariser(DiariserBackend):
    """Two speakers splitting the file, with the real attribution string."""

    kind = "diarise"
    model_id = PYANNOTE_MODEL
    licence = PYANNOTE_LICENCE
    attribution = PYANNOTE_ATTRIBUTION

    def load(self) -> None:
        self._ready = True

    def diarise(self, job: DiariseJob) -> tuple[SpeakerTurn, ...]:
        duration = len(job.samples) / job.sample_rate if job.sample_rate else 0.0
        midpoint = round(duration / 2, 2)
        return (
            SpeakerTurn(speaker="SPEAKER_00", start=0.0, end=midpoint),
            SpeakerTurn(speaker="SPEAKER_01", start=midpoint, end=round(duration, 2)),
        )


class BrokenBackend(AsrBackend):
    """A backend that cannot load, to prove one failure does not stop the app."""

    kind = "asr"
    model_id = "broken"

    def load(self) -> None:
        raise RuntimeError("no weights in this image")

    def transcribe(self, jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        raise AssertionError("never reached")

    def detect_language(self, job: DetectJob) -> list[LanguageVerdict]:
        raise AssertionError("never reached")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def build_settings(**overrides: object) -> Settings:
    """CPU settings with a token, plus whatever the test wants changed."""
    base: dict[str, object] = {
        "device": "cpu",
        "token": TOKEN,
        "preload": ("asr", "align", "diarise"),
        "batch_max_size": 4,
        "batch_window_ms": 25,
        "memory_budget_bytes": 512 * 1024 * 1024,
        "memory_bytes_per_audio_second": 1024 * 1024,
        "max_audio_seconds": 600.0,
        "drain_timeout_s": 2.0,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def build_app(
    *,
    settings: Settings | None = None,
    asr: AsrBackend | None = None,
    aligner: AlignerBackend | None = None,
    diariser: DiariserBackend | None = None,
) -> FastAPI:
    """An app wired to fakes, on a fresh metrics registry."""
    resolved = settings or build_settings()
    registry = ModelRegistry(
        asr=asr if asr is not None else FakeAsr(),
        aligner=aligner if aligner is not None else FakeAligner(),
        diariser=diariser if diariser is not None else FakeDiariser(),
        required=resolved.preload,
    )
    return create_app(resolved, registry=registry, metrics=Metrics.create(), configure_logs=False)


@pytest.fixture
def wav_bytes() -> bytes:
    return make_wav(4.0)


@pytest.fixture
def audio(wav_bytes: bytes) -> str:
    return inline(wav_bytes)


@pytest.fixture
def fake_asr() -> FakeAsr:
    return FakeAsr()


@pytest.fixture
def app(fake_asr: FakeAsr) -> FastAPI:
    return build_app(asr=fake_asr)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as running:
        yield running


@pytest.fixture
def auth() -> dict[str, str]:
    return {"authorization": "Bearer " + TOKEN}


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """``slow`` needs a real model download, so it is opt-in via ``RUN_SLOW=1``.

    The same convention ``apps/worker-ai`` uses. A test that quietly downloads
    75 MB the first time somebody runs the suite is a test that gets skipped by
    everyone, including CI.
    """
    del config
    if os.environ.get("RUN_SLOW", "").strip().casefold() in {"1", "true", "yes"}:
        return
    skip = pytest.mark.skip(reason="needs a real model download; set RUN_SLOW=1")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)


def samples_of(seconds: float, rate: int = 16_000) -> np.ndarray:
    """A silent buffer of a known length, for a backend-level test."""
    return np.zeros(int(seconds * rate), dtype=np.float32)
