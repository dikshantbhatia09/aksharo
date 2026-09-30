"""Pydantic mirror of the ``ai.llm`` kind ``broll`` contract (2026-10-05).

Mirrors ``packages/repurpose-contracts/src/broll.ts`` field for field. Both
sides parse the SAME JSON fixtures in ``packages/repurpose-contracts/fixtures``
(``ai-llm-broll-request.v1.json``, ``ai-llm-broll-output.v1.json``) and assert
the same literal field lists (``tests/test_broll_contracts.py`` and
``src/broll.test.ts``), so a field added on one side fails the other's test
instead of being dropped between the API and this worker.

Every model is ``extra="forbid"``: an unknown key means the producer and the
consumer disagree about the contract.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

__all__ = [
    "BROLL_LLM_KIND",
    "BROLL_TEMPLATE_VERSION",
    "MAX_AVOID",
    "MAX_GAP_MS",
    "MAX_MOMENTS",
    "MAX_WORDS",
    "MAX_WORD_CHARS",
    "PHRASE_MAX",
    "SPOKEN_MAX",
    "TITLE_MAX",
    "BrollMoment",
    "BrollOutput",
    "BrollRequest",
    "BrollSpan",
    "BrollWord",
]

BROLL_LLM_KIND: Final[str] = "broll"
BROLL_TEMPLATE_VERSION: Final[str] = "broll@1"

MAX_WORDS: Final[int] = 1_500
MAX_WORD_CHARS: Final[int] = 64
MAX_MOMENTS: Final[int] = 8
TITLE_MAX: Final[int] = 160
PHRASE_MAX: Final[int] = 60
SPOKEN_MAX: Final[int] = 200
MAX_AVOID: Final[int] = 20
MAX_GAP_MS: Final[int] = 60_000

_WORD_ID: Final[str] = r"^\d+:\d+$"

WordId = Annotated[str, StringConstraints(pattern=_WORD_ID)]


def _trimmed(min_length: int, max_length: int) -> StringConstraints:
    """Zod trims before it measures (``z.string().trim().min(n)``); so must this."""
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)


class _Strict(BaseModel):
    """Shared configuration: reject unknown keys, accept the wire's camelCase."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid", frozen=True)


class BrollWord(_Strict):
    id: WordId
    t: Annotated[str, StringConstraints(min_length=1, max_length=MAX_WORD_CHARS)]
    s: int = Field(ge=0)
    e: int = Field(ge=0)

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> BrollWord:
        if self.e < self.s:
            raise ValueError("a word ends after it starts")
        return self


class BrollSpan(_Strict):
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", ge=0)

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> BrollSpan:
        if self.end_ms <= self.start_ms:
            raise ValueError("a range ends after it starts")
        return self


class BrollRequest(_Strict):
    """What the API asks: ``params.broll`` of an ``ai.llm`` job of kind ``broll``."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    language: Annotated[str, _trimmed(2, 64)]
    title: Annotated[str, _trimmed(1, TITLE_MAX)] | None = None
    words: tuple[BrollWord, ...] = Field(min_length=1, max_length=MAX_WORDS)
    max_moments: int = Field(alias="maxMoments", ge=1, le=MAX_MOMENTS)
    min_gap_ms: int = Field(alias="minGapMs", ge=0, le=MAX_GAP_MS)
    avoid: tuple[BrollSpan, ...] = Field(max_length=MAX_AVOID)


class BrollMoment(_Strict):
    start_word_id: WordId = Field(alias="startWordId")
    end_word_id: WordId = Field(alias="endWordId")
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", ge=0)
    phrase: Annotated[str, _trimmed(2, PHRASE_MAX)]
    spoken: Annotated[str, StringConstraints(max_length=SPOKEN_MAX)]
    score: int = Field(ge=0, le=10)


class BrollOutput(_Strict):
    """What the worker answers: the ``output`` of the job's result."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    moments: tuple[BrollMoment, ...] = Field(max_length=MAX_MOMENTS)
    source: Literal["model", "none"]
