"""Output schemas the provider's JSON reply is validated against.

Mirrors ``packages/prompts/src/templates/{chapters,summary,hooks}.ts``'s Zod
schemas. Validation failure is not fatal here — ``service.py`` sends it back to
the provider as a repair instruction once before giving up — so every validator
returns a list of human-readable errors rather than raising.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

__all__ = [
    "Chapter",
    "ChaptersOutput",
    "HooksOutput",
    "Keyphrase",
    "KeyphrasesOutput",
    "MusicMoodOutput",
    "MusicMoodScore",
    "PlatformVariant",
    "SummaryOutput",
    "ValidationOutcome",
    "schema_for",
    "validate_output",
]


class ValidationOutcome(BaseModel):
    ok: bool
    errors: tuple[str, ...] = ()
    value: dict[str, Any] | None = None


class Chapter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    start_ms: int = Field(ge=0, alias="startMs")
    title: str = Field(min_length=1, max_length=60)


class ChaptersOutput(BaseModel):
    chapters: tuple[Chapter, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _ordered(self) -> ChaptersOutput:
        for previous, current in zip(self.chapters, self.chapters[1:], strict=False):
            if current.start_ms <= previous.start_ms:
                raise ValueError("chapters must be strictly ordered by startMs")
        return self


class SummaryOutput(BaseModel):
    short: str = Field(min_length=1, max_length=240)
    medium: str = Field(min_length=1, max_length=600)
    long: str = Field(min_length=1, max_length=1_200)


_HASHTAG_RE = r"^#[^\s#]+$"


class PlatformVariant(BaseModel):
    hooks: tuple[str, ...] = Field(min_length=5, max_length=5)
    titles: tuple[str, ...] = Field(min_length=5, max_length=5)
    hashtags: tuple[str, ...] = Field(min_length=10, max_length=10)

    @field_validator("hooks")
    @classmethod
    def _hook_len(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for item in value:
            if not (1 <= len(item) <= 120):
                raise ValueError(f"hook {item!r} must be 1-120 chars")
        return value

    @field_validator("titles")
    @classmethod
    def _title_len(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for item in value:
            if not (1 <= len(item) <= 100):
                raise ValueError(f"title {item!r} must be 1-100 chars")
        return value

    @field_validator("hashtags")
    @classmethod
    def _hashtag_shape(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for item in value:
            if not re.match(_HASHTAG_RE, item):
                raise ValueError(f"hashtag {item!r} must start with # and contain no spaces")
        return value


class HooksOutput(BaseModel):
    youtube: PlatformVariant
    instagram: PlatformVariant
    tiktok: PlatformVariant


class Keyphrase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    phrase: str = Field(min_length=1, max_length=80)
    start_ms: int = Field(ge=0, alias="startMs")
    end_ms: int = Field(ge=0, alias="endMs")

    @model_validator(mode="after")
    def _ordered(self) -> Keyphrase:
        if self.end_ms < self.start_ms:
            raise ValueError("endMs must not precede startMs")
        return self


class KeyphrasesOutput(BaseModel):
    keyphrases: tuple[Keyphrase, ...] = Field(default=())


class MusicMoodScore(BaseModel):
    index: int = Field(ge=0)
    sentiment: float = Field(ge=-1, le=1)


class MusicMoodOutput(BaseModel):
    scores: tuple[MusicMoodScore, ...] = Field(default=())

    @field_validator("scores")
    @classmethod
    def _unique_indices(cls, value: tuple[MusicMoodScore, ...]) -> tuple[MusicMoodScore, ...]:
        indices = [score.index for score in value]
        if len(indices) != len(set(indices)):
            raise ValueError("each segment index must appear at most once in scores")
        return value


InsightKind = Literal["chapters", "summary", "hooks", "keyphrases", "music-mood"]

_SCHEMAS: dict[str, type[BaseModel]] = {
    "chapters": ChaptersOutput,
    "summary": SummaryOutput,
    "hooks": HooksOutput,
    "keyphrases": KeyphrasesOutput,
    "music-mood": MusicMoodOutput,
}


def schema_for(kind: InsightKind) -> type[BaseModel]:
    return _SCHEMAS[kind]


def validate_output(kind: InsightKind, raw: dict[str, Any]) -> ValidationOutcome:
    """Validate ``raw`` (already JSON-decoded) against ``kind``'s schema."""
    model = schema_for(kind)
    try:
        parsed = model.model_validate(raw)
    except ValidationError as error:
        errors = tuple(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in error.errors())
        return ValidationOutcome(ok=False, errors=errors, value=None)
    dumped = parsed.model_dump(mode="json", by_alias=True)
    return ValidationOutcome(ok=True, errors=(), value=dumped)
