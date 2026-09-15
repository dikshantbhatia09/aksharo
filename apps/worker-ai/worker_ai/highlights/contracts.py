"""Pydantic mirror of ``ai.highlights@1`` (REP-005).

Mirrors ``packages/repurpose-contracts/src/jobs.ts`` field for field. Both sides
parse the SAME JSON fixtures in ``packages/repurpose-contracts/fixtures``, and
``tests/test_highlight_contracts.py`` asserts the same literal field lists the
TypeScript test asserts, so a field added on one side fails the other's test
instead of being silently dropped between the API and this worker.

Every model is ``extra="forbid"``: an unknown key in a payload means the producer
and the consumer disagree about the contract, and guessing which one is right is
how a worker ends up analysing the wrong revision of a transcript.

No processor consumes this yet. ``ai.highlights`` is a registered queue that
answers ``worker/not_implemented`` until Wave 4 (``queues.py``), and the
``highlight_discovery`` flag is seeded off.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

__all__ = [
    "HIGHLIGHTS_SCHEMA_VERSION",
    "MAX_DURATION_MS",
    "MIN_DURATION_MS",
    "HighlightProposal",
    "HighlightsOptions",
    "HighlightsPayload",
    "HighlightsResult",
    "ProposalReason",
    "ScoreBreakdown",
    "StorageObject",
    "highlights_job_key",
]

HIGHLIGHTS_SCHEMA_VERSION: Final[int] = 1

#: The hard bounds a candidate must satisfy whatever the run configuration says.
#: Identical to the check constraint on ``clip_candidates`` (REP-003).
MIN_DURATION_MS: Final[int] = 3_000
MAX_DURATION_MS: Final[int] = 180_000

#: Crockford base32, 26 characters - the same shape `UlidSchema` pins on the
#: TypeScript side. A length check alone would let `../` and a lower-case id
#: through, and these values end up in storage keys and database lookups.
_ULID_PATTERN: Final[str] = r"^[0-9A-HJKMNP-TV-Z]{26}$"

#: A plain relative object key: no traversal, no absolute path, no backslash.
#: Mirrors `StorageKeySchema` in `packages/repurpose-contracts/src/jobs.ts`.
_STORAGE_KEY_PATTERN: Final[str] = r"^[A-Za-z0-9][A-Za-z0-9/_.-]*$"

Ulid = Annotated[str, StringConstraints(pattern=_ULID_PATTERN)]

#: A string the TypeScript side declares as `z.string().trim().min(n)`. Zod trims
#: BEFORE it measures, so `"   "` fails there; Pydantic's `min_length` measures the
#: raw value, so without `strip_whitespace` the same payload would pass here and
#: fail there. Both sides must agree on what an empty string is.
def _trimmed(min_length: int, max_length: int) -> object:
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)


_ReasonLabel = Literal[
    "hook",
    "clear_point",
    "emotion",
    "visual",
    "novelty",
    "standalone",
    "safety",
]


class _Strict(BaseModel):
    """Shared configuration: reject unknown keys, accept the wire's camelCase."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid", frozen=True)


class StorageObject(_Strict):
    bucket: Literal["s3", "r2"]
    #: Pattern, not just length: this value becomes a path, and a key that escapes
    #: its `ws/{workspaceId}` prefix is a cross-tenant read (THREAT-MODEL T5).
    key: Annotated[str, StringConstraints(pattern=_STORAGE_KEY_PATTERN, max_length=512)]

    @model_validator(mode="after")
    def _key_does_not_traverse(self) -> StorageObject:
        #: The pattern alone cannot express this: `.` and `/` are both legal
        #: characters in a key, so `ws/a/p/b/../../../etc/passwd` matches it. The
        #: TypeScript contract carries the same check as a separate refinement
        #: (`StorageKeySchema` in jobs.ts), and both sides need it or neither does.
        if ".." in self.key:
            raise ValueError("storage key must not traverse")
        return self


class HighlightsOptions(_Strict):
    count: int = Field(ge=1, le=20)
    min_duration_ms: int = Field(alias="minDurationMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    max_duration_ms: int = Field(alias="maxDurationMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    content_goal: Literal["reach", "education", "authority", "engagement"] = Field(
        alias="contentGoal"
    )
    #: The language to reason IN. Hinglish is ``hi-Latn``, never flattened to English.
    language: Annotated[str, _trimmed(2, 64)]

    @model_validator(mode="after")
    def _duration_range_is_ordered(self) -> HighlightsOptions:
        if self.min_duration_ms > self.max_duration_ms:
            raise ValueError("minDurationMs is above maxDurationMs")
        return self


class HighlightsPayload(_Strict):
    """What the API sends. The transcript REVISION is pinned, not just its id."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    run_id: Ulid = Field(alias="runId")
    project_id: Ulid = Field(alias="projectId")
    transcript_id: Ulid = Field(alias="transcriptId")
    transcript_revision: int = Field(alias="transcriptRevision", ge=1)
    proxy: StorageObject
    waveform: StorageObject | None = None
    options: HighlightsOptions
    prompt_version: Annotated[str, _trimmed(1, 100)] = Field(alias="promptVersion")
    feature_version: Annotated[str, _trimmed(1, 100)] = Field(alias="featureVersion")


class ScoreBreakdown(_Strict):
    hook: int = Field(ge=0, le=100)
    clarity: int = Field(ge=0, le=100)
    emotion: int = Field(ge=0, le=100)
    visual_activity: int = Field(alias="visualActivity", ge=0, le=100)
    novelty: int = Field(ge=0, le=100)
    standalone_value: int = Field(alias="standaloneValue", ge=0, le=100)
    safety: int = Field(ge=0, le=100)


class ProposalReason(_Strict):
    label: _ReasonLabel
    explanation: Annotated[str, _trimmed(1, 240)]


class HighlightProposal(_Strict):
    """One proposal.

    ``window_id`` is required because the model SELECTS an enumerated window; it
    does not invent a timecode. Keeping the id makes that checkable after the
    fact, which is what the zero-invalid-timestamp release gate rests on.
    """

    window_id: Annotated[str, _trimmed(1, 100)] = Field(alias="windowId")
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", gt=0)
    start_word_id: Annotated[str, _trimmed(1, 100)] = Field(alias="startWordId")
    end_word_id: Annotated[str, _trimmed(1, 100)] = Field(alias="endWordId")
    title: Annotated[str, _trimmed(1, 160)]
    transcript_excerpt: str = Field(alias="transcriptExcerpt", max_length=2_000)
    potential_score: int = Field(alias="potentialScore", ge=0, le=100)
    score_breakdown: ScoreBreakdown = Field(alias="scoreBreakdown")
    reasons: tuple[ProposalReason, ...] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def _duration_is_within_hard_limits(self) -> HighlightProposal:
        duration = self.end_ms - self.start_ms
        if duration < MIN_DURATION_MS or duration > MAX_DURATION_MS:
            raise ValueError("proposal duration must be 3-180 seconds")
        return self


class HighlightsResult(_Strict):
    """What the worker returns.

    An empty ``proposals`` list is a legitimate answer: returning fewer, better
    candidates is the documented behaviour, and padding a thin source with weak
    clips is not (master plan §10.2).
    """

    schema_version: Literal[1] = Field(alias="schemaVersion")
    run_id: Ulid = Field(alias="runId")
    transcript_id: Ulid = Field(alias="transcriptId")
    transcript_revision: int = Field(alias="transcriptRevision", ge=1)
    proposals: tuple[HighlightProposal, ...] = Field(max_length=20)
    feature_version: Annotated[str, _trimmed(1, 100)] = Field(alias="featureVersion")
    prompt_version: Annotated[str, _trimmed(1, 100)] = Field(alias="promptVersion")
    model: Annotated[str, _trimmed(1, 100)]
    windows_considered: int = Field(alias="windowsConsidered", ge=0, le=10_000)


def highlights_job_key(
    run_id: str,
    transcript_id: str,
    revision: int,
    config_fingerprint: str,
) -> str:
    """``ai.highlights:{runId}:{transcriptId}:{revision}:{configFingerprint}``.

    Identical to ``highlightsJobKey`` in the TypeScript contracts. The revision is
    part of the key on purpose: an edited transcript is a different analysis, not
    a cache hit.
    """
    return f"ai.highlights:{run_id}:{transcript_id}:{revision}:{config_fingerprint}"
