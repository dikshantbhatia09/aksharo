"""Pydantic mirror of ``ai.highlights@1`` (REP-005).

Mirrors ``packages/repurpose-contracts/src/jobs.ts`` field for field. Both sides
parse the SAME JSON fixtures in ``packages/repurpose-contracts/fixtures``, and
``tests/test_highlight_contracts.py`` asserts the same literal field lists the
TypeScript test asserts, so a field added on one side fails the other's test
instead of being silently dropped between the API and this worker.

Every model is ``extra="forbid"``: an unknown key in a payload means the producer
and the consumer disagree about the contract, and guessing which one is right is
how a worker ends up analysing the wrong revision of a transcript.

``worker_ai.processors.highlights`` consumes the payload and produces the result.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Final, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

__all__ = [
    "HIGHLIGHTS_SCHEMA_VERSION",
    "MAX_DURATION_MS",
    "MIN_DURATION_MS",
    "ClipCopy",
    "CopyOptions",
    "ExcludeRange",
    "HighlightProposal",
    "HighlightsOptions",
    "HighlightsPayload",
    "HighlightsResult",
    "Judgement",
    "PerformanceHit",
    "PerformanceHook",
    "PerformanceLength",
    "PerformanceSignal",
    "PlatformCopy",
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


#: ``track_record`` (2026-10-05) is the chip the workspace's own posted clips
#: add ("like your clip about ... that got 12k views"); it is only ever emitted
#: for a payload that carried ``options.performance``.
_ReasonLabel = Literal[
    "hook",
    "clear_point",
    "emotion",
    "visual",
    "novelty",
    "standalone",
    "safety",
    "track_record",
]

#: Mirrors ``PERFORMANCE_PLATFORMS`` and ``HOOK_STYLES`` in ``jobs.ts``.
_PerformancePlatform = Literal[
    "youtube", "instagram", "tiktok", "linkedin", "x", "facebook", "threads"
]
_HookStyle = Literal["question", "number", "you", "statement"]
#: A post's count: a Postgres ``integer``.
_MAX_COUNT: Final[int] = 2_147_483_647


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


class ExcludeRange(_Strict):
    """A part of the source to take no clip from (2026-09-29)."""

    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", gt=0)

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> ExcludeRange:
        if self.end_ms <= self.start_ms:
            raise ValueError("a range must end after it starts")
        return self


class CopyOptions(_Strict):
    """Write each proposal's copy with the language model, in this language."""

    language: Annotated[str, _trimmed(2, 64)]
    script_mode: Literal["auto", "roman", "native", "bilingual"] = Field(alias="scriptMode")


class PerformanceHit(_Strict):
    """One of the workspace's best posted clips (2026-10-05)."""

    title: Annotated[str, _trimmed(1, 160)]
    hook: Annotated[str, _trimmed(1, 500)] | None = None
    excerpt: Annotated[str, _trimmed(1, 600)] | None = None
    views: int = Field(ge=0, le=_MAX_COUNT)
    platform: _PerformancePlatform


class PerformanceLength(_Strict):
    """The length band that did clearly better than the rest."""

    min_ms: int = Field(alias="minMs", ge=0, le=MAX_DURATION_MS)
    max_ms: int = Field(alias="maxMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    posts: int = Field(ge=1, le=1_000_000)

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> PerformanceLength:
        if self.max_ms <= self.min_ms:
            raise ValueError("a length band must end after it starts")
        return self


class PerformanceHook(_Strict):
    """The kind of opening that did clearly better than the rest."""

    style: _HookStyle
    posts: int = Field(ge=1, le=1_000_000)


class PerformanceSignal(_Strict):
    """What a workspace's posted clips say worked: ``options.performance``.

    Mirrors ``PerformanceSignalSchema`` (``jobs.ts``). Sent only once the
    workspace has enough measured posts; ``worker_ai.highlights.performance``
    turns it into a small, capped lift that never overrides the person's own
    steering.
    """

    basis: int = Field(ge=1, le=1_000_000)
    hits: tuple[PerformanceHit, ...] = Field(max_length=5)
    length: PerformanceLength | None = None
    hook: PerformanceHook | None = None


class HighlightsOptions(_Strict):
    count: int = Field(ge=1, le=40)
    #: The bar a moment must clear to be returned at all (0-1); ``None`` keeps
    #: the best ``count`` however they score.
    min_potential: float | None = Field(default=None, alias="minPotential", ge=0, le=1)
    min_duration_ms: int = Field(alias="minDurationMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    max_duration_ms: int = Field(alias="maxDurationMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    content_goal: Literal["reach", "education", "authority", "engagement"] = Field(
        alias="contentGoal"
    )
    #: The language to reason IN. Hinglish is ``hi-Latn``, never flattened to English.
    language: Annotated[str, _trimmed(2, 64)]
    #: What the clips should be about, in the person's words (2026-09-29).
    topic: Annotated[str, _trimmed(2, 200)] | None = None
    #: Parts of the source to take no clip from.
    exclude_ranges: tuple[ExcludeRange, ...] | None = Field(
        default=None, alias="excludeRanges", max_length=20
    )
    #: Write per-proposal copy with the language model.
    copy_options: CopyOptions | None = Field(default=None, alias="copy")
    #: The workspace's jurisdiction: which language-model providers may read
    #: these words (`worker_ai.llm.region`). Absent is `in`, the platform
    #: default, exactly as `ai.llm` treats a payload without one.
    region: Literal["in", "eu", "us"] | None = None
    #: What the workspace's posted clips say worked (2026-10-05); absent
    #: without enough measured posts, and from an API that predates it.
    performance: PerformanceSignal | None = None

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


def _hashtag(value: str) -> str:
    """A hashtag as the TypeScript `HashtagSchema` pins it: `#` then letters,
    combining marks, digits or underscores, in any script.

    Not a `\\w` pattern: a Devanagari vowel sign or anusvara is a combining
    mark, which `\\w` does not match, so `#हिंदी` would be refused.
    """
    body = value[1:]
    if not value.startswith("#") or not body:
        raise ValueError("a hashtag starts with # and has something after it")
    if not all(char == "_" or unicodedata.category(char)[0] in "LMN" for char in body):
        raise ValueError("a hashtag holds only letters, marks, digits and underscores")
    return value


Hashtag = Annotated[str, StringConstraints(max_length=100), AfterValidator(_hashtag)]


class _YouTubeCopy(_Strict):
    title: Annotated[str, _trimmed(1, 100)]
    description: Annotated[str, _trimmed(0, 5_000)]


class _CaptionCopy(_Strict):
    caption: Annotated[str, _trimmed(1, 2_200)]


class _TextCopy(_Strict):
    text: Annotated[str, _trimmed(1, 5_000)]


class _XCopy(_Strict):
    text: Annotated[str, _trimmed(1, 280)]


class _LinkedInCopy(_Strict):
    text: Annotated[str, _trimmed(1, 3_000)]


class PlatformCopy(_Strict):
    youtube: _YouTubeCopy | None = None
    instagram: _CaptionCopy | None = None
    tiktok: _CaptionCopy | None = None
    linkedin: _LinkedInCopy | None = None
    x: _XCopy | None = None
    facebook: _TextCopy | None = None


class ClipCopy(_Strict):
    """Mirrors ``ClipCopySchema``: the words that go with a clip when posted."""

    summary: Annotated[str, _trimmed(0, 2_000)]
    hook: Annotated[str, _trimmed(0, 500)]
    cta: Annotated[str, _trimmed(0, 500)]
    hashtags: tuple[Hashtag, ...] = Field(max_length=30)
    locale: Annotated[str, _trimmed(2, 64)]
    title: Annotated[str, _trimmed(1, 160)] | None = None
    description: Annotated[str, _trimmed(0, 2_000)] | None = None
    platforms: PlatformCopy | None = None
    source: Literal["model", "heuristic", "person"] | None = None


class JudgementNotes(_Strict):
    """One sentence each on a moment's hook, flow, value and trend (2026-10-01)."""

    hook: Annotated[str, _trimmed(1, 240)] | None = None
    flow: Annotated[str, _trimmed(1, 240)] | None = None
    value: Annotated[str, _trimmed(1, 240)] | None = None
    trend: Annotated[str, _trimmed(1, 240)] | None = None


class Judgement(_Strict):
    """The language model's reading of a moment, 0-10 each.

    ``hook``, ``trend``, ``notes`` and ``people`` (2026-10-01) are the clip
    analysis its page shows (OpusClip's Hook / Flow / Value / Trend and
    "Relevant people"); optional, because a model may leave them out.
    """

    standalone: int = Field(ge=0, le=10)
    payoff: int = Field(ge=0, le=10)
    humour: int = Field(ge=0, le=10)
    topic_fit: int | None = Field(default=None, alias="topicFit", ge=0, le=10)
    hook: int | None = Field(default=None, ge=0, le=10)
    trend: int | None = Field(default=None, ge=0, le=10)
    notes: JudgementNotes | None = None
    people: tuple[Annotated[str, _trimmed(1, 60)], ...] | None = Field(default=None, max_length=5)
    model: Annotated[str, _trimmed(1, 100)]


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
    copy_text: ClipCopy | None = Field(default=None, alias="copy")
    judgement: Judgement | None = None

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
    proposals: tuple[HighlightProposal, ...] = Field(max_length=40)
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
