"""Pydantic mirror of ``ai.voiceover@1`` (2026-10-01).

Mirrors ``packages/repurpose-contracts/src/voiceover.ts`` field for field. Both
sides parse the SAME JSON fixtures in ``packages/repurpose-contracts/fixtures``
and assert the same literal field lists (``tests/test_voiceover_contracts.py``
and ``src/voiceover.test.ts``), so a field added on one side fails the other's
test instead of being dropped between the API and this worker.

Every model is ``extra="forbid"``. The key pattern is the TypeScript one,
character for character: the worker writes only the voice-over's own file,
whatever a payload says.
"""

from __future__ import annotations

from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

__all__ = [
    "MAX_AUDIO_BYTES",
    "MAX_DURATION_MS",
    "MAX_TEXT_CHARS",
    "MIN_TEXT_CHARS",
    "SAMPLE_RATE",
    "SCHEMA_VERSION",
    "VOICEOVER_KEY_PATTERN",
    "VOICEOVER_LANGUAGES",
    "VOICEOVER_MODEL",
    "VOICEOVER_SPEAKERS",
    "VoiceoverCheckpoint",
    "VoiceoverPayload",
    "VoiceoverResult",
]

SCHEMA_VERSION: Final[int] = 1

#: Sarvam's text-to-speech languages (``bulbul:v3``); Odia is ``od-IN`` here.
VOICEOVER_LANGUAGES: Final[tuple[str, ...]] = (
    "en-IN",
    "hi-IN",
    "bn-IN",
    "gu-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "od-IN",
    "pa-IN",
    "ta-IN",
    "te-IN",
)
VoiceoverLanguage = Literal[
    "en-IN",
    "hi-IN",
    "bn-IN",
    "gu-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "od-IN",
    "pa-IN",
    "ta-IN",
    "te-IN",
]

#: The stock voices, never a person's own (so nobody's voice is cloned).
VOICEOVER_SPEAKERS: Final[tuple[str, ...]] = (
    "priya",
    "neha",
    "kavya",
    "shreya",
    "shubh",
    "rahul",
    "aditya",
)
VoiceoverSpeaker = Literal["priya", "neha", "kavya", "shreya", "shubh", "rahul", "aditya"]

VOICEOVER_MODEL: Final[str] = "bulbul:v3"

#: ``VOICEOVER_LIMITS`` in ``voiceover.ts``.
MAX_TEXT_CHARS: Final[int] = 300
MIN_TEXT_CHARS: Final[int] = 2
MIN_PACE: Final[float] = 0.75
MAX_PACE: Final[float] = 1.25
SAMPLE_RATE: Final[int] = 22_050
MAX_DURATION_MS: Final[int] = 30_000
MAX_AUDIO_BYTES: Final[int] = 8 * 1024 * 1024

#: ``VOICEOVER_KEY_PATTERN`` in ``voiceover.ts``, character for character.
VOICEOVER_KEY_PATTERN: Final[str] = (
    r"^ws/[0-9A-HJKMNP-TV-Z]{26}/p/[0-9A-HJKMNP-TV-Z]{26}/repurpose/[0-9A-HJKMNP-TV-Z]{26}"
    r"/voiceovers/[0-9A-HJKMNP-TV-Z]{26}/hook\.wav$"
)

_ULID: Final[str] = r"^[0-9A-HJKMNP-TV-Z]{26}$"
Ulid = Annotated[str, StringConstraints(pattern=_ULID)]
VoiceoverKey = Annotated[str, StringConstraints(max_length=240, pattern=VOICEOVER_KEY_PATTERN)]


class _Strict(BaseModel):
    """Refuses unknown keys; reads and writes the TypeScript (camelCase) names."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def to_wire(self) -> dict[str, Any]:
        """The JSON the TypeScript side parses: camelCase, absent fields left out."""
        return self.model_dump(by_alias=True, exclude_none=True)


class VoiceoverDestination(_Strict):
    key: VoiceoverKey


class VoiceoverPayload(_Strict):
    """``ai.voiceover@1``: say ``text`` in ``language`` with ``speaker``'s voice."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    run_id: Ulid = Field(alias="runId")
    clip_id: Ulid = Field(alias="clipId")
    voiceover_id: Ulid = Field(alias="voiceoverId")
    text: str
    language: VoiceoverLanguage
    speaker: VoiceoverSpeaker
    pace: float = Field(ge=MIN_PACE, le=MAX_PACE)
    model: Literal["bulbul:v3"]
    destination: VoiceoverDestination

    @field_validator("text")
    @classmethod
    def _trimmed(cls, value: str) -> str:
        # zod's `.trim().min().max()`: the bounds are on the trimmed words.
        trimmed = value.strip()
        if not MIN_TEXT_CHARS <= len(trimmed) <= MAX_TEXT_CHARS:
            raise ValueError(f"text is {MIN_TEXT_CHARS}-{MAX_TEXT_CHARS} characters")
        return trimmed


class VoiceoverResult(_Strict):
    """What came back: the stored WAV, measured from its own header."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    voiceover_id: Ulid = Field(alias="voiceoverId")
    key: VoiceoverKey
    content_type: Literal["audio/wav"] = Field(alias="contentType")
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=MAX_AUDIO_BYTES)
    duration_ms: int = Field(alias="durationMs", ge=1, le=MAX_DURATION_MS)
    characters: int = Field(ge=1, le=MAX_TEXT_CHARS)
    reused: bool


class VoiceoverCheckpoint(_Strict):
    """What the worker records once the WAV is stored: enough to answer again for free."""

    key: VoiceoverKey
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=MAX_AUDIO_BYTES)
    duration_ms: int = Field(alias="durationMs", ge=1, le=MAX_DURATION_MS)
    characters: int = Field(ge=1, le=MAX_TEXT_CHARS)
