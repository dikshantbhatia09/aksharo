"""Deterministic provider backed by a word fixture.

It is the default lane on a machine with no vendor credentials — every developer
machine, CI, and the Playwright end-to-end suite — and it is the provider the eval
harness runs to prove the harness itself before a real set exists (`09 §8`).

Determinism is the whole point: the same audio uri and language always yield the
same words with the same timings, so a snapshot of a transcript is a stable
fixture. Words come from ``fixtures/<set>/words/<id>.json`` when the caller names
one, and otherwise from a built-in Hinglish sample.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

__all__ = ["MOCK_HINGLISH_SAMPLE", "MockProvider", "load_word_fixture"]

#: A short Hinglish utterance: Roman-script Hindi with English words kept as-is,
#: which is exactly the code-mix shape the Hinglish lane has to handle (`09 §4`).
MOCK_HINGLISH_SAMPLE: tuple[str, ...] = (
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
    "matlab",
    "captions",
    "kaise",
    "banate",
    "hain",
)

#: Milliseconds of speech per word, and of gap after it. Fixed so timings are
#: reproducible and monotonic without pretending to be realistic.
_WORD_MS = 320
_GAP_MS = 80


def load_word_fixture(path: Path) -> tuple[str, ...]:
    """Read a fixture of plain words: a JSON list, or ``{"words": [...]}``."""
    try:
        parsed: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProviderError(
            f"could not read the word fixture {path.name}: {error}",
            provider="mock",
            retryable=False,
        ) from error
    if isinstance(parsed, dict):
        parsed = parsed.get("words", [])
    if not isinstance(parsed, list):
        raise ProviderError(
            f"{path.name} must hold a list of words", provider="mock", retryable=False
        )
    return tuple(str(item) for item in parsed)


class MockProvider(Provider):
    """Words from a fixture, timed on a fixed grid inside the requested chunk."""

    name = "mock"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe", "align", "diarise"}),
        word_timestamps=True,
        diarisation=False,
        max_duration_s=None,
        batch=False,
        languages=(),
    )

    cost_per_minute_inr = 0.0
    reads_audio = False

    def __init__(
        self,
        *,
        words: tuple[str, ...] = MOCK_HINGLISH_SAMPLE,
        default_language: str = "hi-en",
    ) -> None:
        #: Words used when the request names no fixture.
        self.words = words
        #: Language reported when the request does not pin one.
        self.default_language = default_language

    def _words_for(self, request: TranscriptionRequest) -> tuple[tuple[str, ...], bool]:
        """The words to emit, and whether they were pinned by the caller.

        A pinned list is returned verbatim: the eval harness compares it against a
        hand-written reference, and a rotation would be measuring the mock's
        shuffling rather than the harness.
        """
        fixture = request.options.get("wordFixture")
        if isinstance(fixture, str) and fixture:
            return load_word_fixture(Path(fixture)), True
        override = request.options.get("words")
        if isinstance(override, list | tuple):
            return tuple(str(item) for item in override), True
        return self.words, False

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        source, pinned = self._words_for(request)
        # A stable rotation keyed on the audio uri, so two chunks of one file do
        # not produce byte-identical transcripts while each stays reproducible.
        digest = hashlib.sha256(request.audio_uri.encode("utf-8")).digest()
        rotation = 0 if pinned else digest[0] % max(1, len(source))
        rotated = source[rotation:] + source[:rotation]

        words: list[Word] = []
        cursor = request.offset_ms
        for index, text in enumerate(rotated):
            words.append(
                Word(
                    s=cursor,
                    e=cursor + _WORD_MS,
                    t=text,
                    c=round(0.80 + (index % 5) * 0.04, 2),
                )
            )
            cursor += _WORD_MS + _GAP_MS

        language = request.language or self.default_language
        seconds = (cursor - request.offset_ms) / 1000
        return TranscriptionResult(
            words=tuple(words),
            language=language,
            language_confidence=0.99,
            usage=ProviderUsage(
                media_seconds=seconds,
                provider=self.name,
                model="fixture-v1",
                cost_minor=self.cost_estimate(seconds).minor,
            ),
            submissions=(
                ProviderSubmission(
                    provider=self.name,
                    endpoint="local://mock",
                    artefact=request.audio_uri,
                    retention_class="none",
                ),
            ),
            raw={"fixtureWords": len(rotated), "rotation": rotation},
        )

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        """Lay the given words on the same fixed grid, inside the request's span."""
        end_ms = request.end_ms
        words: list[Word] = []
        if request.words:
            span = (end_ms - request.start_ms) if end_ms is not None else None
            step = (
                max(1, span // len(request.words))
                if span is not None and span > 0
                else _WORD_MS + _GAP_MS
            )
            cursor = request.start_ms + request.offset_ms
            for text in request.words:
                words.append(Word(s=cursor, e=cursor + max(1, step - _GAP_MS), t=text))
                cursor += step
        return TranscriptionResult(words=tuple(words), language=request.language)

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """One speaker covering every region — the same answer as ``NoopDiariser``."""
        if not request.regions:
            return (DiarisedSpeaker(speaker_id="S1", start_ms=0, end_ms=0, confidence=1.0),)
        return tuple(
            DiarisedSpeaker(speaker_id="S1", start_ms=start, end_ms=end, confidence=1.0)
            for start, end in request.regions
        )
