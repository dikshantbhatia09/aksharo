"""Pydantic mirror of ``ai.dub@1`` (2026-10-04).

Mirrors ``packages/repurpose-contracts/src/dubbing.ts`` field for field. Both
sides parse the SAME JSON fixtures in ``packages/repurpose-contracts/fixtures``
and assert the same literal field lists (``tests/test_dub_contracts.py``), so a
field added on one side fails the other's test instead of being dropped between
the API and this worker.

Every model is ``extra="forbid"``. The key patterns are the TypeScript ones,
character for character: the worker reads only a clip's clean video and writes
only inside the dub's own folder, whatever a payload says.
"""

from __future__ import annotations

from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, model_validator

__all__ = [
    "CLIP_VIDEO_KEY_PATTERN",
    "DUB_FOLDER_PATTERN",
    "DUB_KEY_PATTERN",
    "DUB_LANGUAGES",
    "MAX_AUDIO_BYTES",
    "MAX_CAPTIONS_BYTES",
    "SCHEMA_VERSION",
    "DubAudioFile",
    "DubCancelPayload",
    "DubCancelResult",
    "DubCaptionsFile",
    "DubCheckpoint",
    "DubLanguage",
    "DubRunPayload",
    "DubRunResult",
    "DubTrack",
    "parse_dub_payload",
]

SCHEMA_VERSION: Final[int] = 1

#: Sarvam's dubbing languages, as its API spells them (Odia is ``or-IN`` here).
DUB_LANGUAGES: Final[tuple[str, ...]] = (
    "en-IN",
    "hi-IN",
    "bn-IN",
    "gu-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "or-IN",
    "pa-IN",
    "ta-IN",
    "te-IN",
    "as-IN",
)

DubLanguage = Literal[
    "en-IN",
    "hi-IN",
    "bn-IN",
    "gu-IN",
    "kn-IN",
    "ml-IN",
    "mr-IN",
    "or-IN",
    "pa-IN",
    "ta-IN",
    "te-IN",
    "as-IN",
]

MIN_DURATION_MS: Final[int] = 1_000
MAX_DURATION_MS: Final[int] = 60 * 60_000
MAX_SPEAKERS: Final[int] = 10
MAX_LANGUAGES: Final[int] = len(DUB_LANGUAGES) - 1
MAX_AUDIO_BYTES: Final[int] = 200 * 1024 * 1024
MAX_CAPTIONS_BYTES: Final[int] = 2 * 1024 * 1024

_ULID: Final[str] = r"^[0-9A-HJKMNP-TV-Z]{26}$"

#: The patterns of ``dubbing.ts``, character for character.
DUB_FOLDER_PATTERN: Final[str] = (
    r"^ws/[0-9A-HJKMNP-TV-Z]{26}/p/[0-9A-HJKMNP-TV-Z]{26}/repurpose/[0-9A-HJKMNP-TV-Z]{26}"
    r"/dubs/[0-9A-HJKMNP-TV-Z]{26}$"
)
DUB_KEY_PATTERN: Final[str] = (
    r"^ws/[0-9A-HJKMNP-TV-Z]{26}/p/[0-9A-HJKMNP-TV-Z]{26}/repurpose/[0-9A-HJKMNP-TV-Z]{26}"
    r"/dubs/[0-9A-HJKMNP-TV-Z]{26}/(?:en|hi|bn|gu|kn|ml|mr|or|pa|ta|te|as)-IN/"
    r"(?:audio\.(?:mp3|wav|m4a|aac|ogg|opus|flac|webm)|captions\.srt|(?:9x16|4x5|1x1|16x9)\.mp4)$"
)
CLIP_VIDEO_KEY_PATTERN: Final[str] = (
    r"^ws/[0-9A-HJKMNP-TV-Z]{26}/p/[0-9A-HJKMNP-TV-Z]{26}/repurpose/[0-9A-HJKMNP-TV-Z]{26}"
    r"/clips/[0-9A-HJKMNP-TV-Z]{26}/master(?:-(?:4x5|1x1|16x9))?\.mp4$"
)
_VENDOR_JOB_ID: Final[str] = r"^[A-Za-z0-9_-]+$"

Ulid = Annotated[str, StringConstraints(pattern=_ULID)]
VendorJobId = Annotated[
    str, StringConstraints(min_length=1, max_length=128, pattern=_VENDOR_JOB_ID)
]
DubFolder = Annotated[str, StringConstraints(max_length=200, pattern=DUB_FOLDER_PATTERN)]
DubKey = Annotated[str, StringConstraints(max_length=240, pattern=DUB_KEY_PATTERN)]
ClipVideoKey = Annotated[str, StringConstraints(max_length=240, pattern=CLIP_VIDEO_KEY_PATTERN)]


class _Strict(BaseModel):
    """Refuses unknown keys; reads and writes the TypeScript (camelCase) names."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    def to_wire(self) -> dict[str, Any]:
        """The JSON the TypeScript side parses: camelCase, absent fields left out."""
        return self.model_dump(by_alias=True, exclude_none=True)


class DubSource(_Strict):
    """The clip's clean 9:16 video, in the derived store."""

    key: ClipVideoKey
    content_type: Literal["video/mp4"] = Field(alias="contentType")


class DubRunPayload(_Strict):
    """``ai.dub@1`` with ``action: "dub"``: one vendor job for every language."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    action: Literal["dub"]
    run_id: Ulid = Field(alias="runId")
    clip_id: Ulid = Field(alias="clipId")
    dub_id: Ulid = Field(alias="dubId")
    source: DubSource
    duration_ms: int = Field(alias="durationMs", ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    source_language: DubLanguage = Field(alias="sourceLanguage")
    target_languages: list[DubLanguage] = Field(
        alias="targetLanguages", min_length=1, max_length=MAX_LANGUAGES
    )
    speakers: int = Field(ge=-1, le=MAX_SPEAKERS)
    destination_prefix: DubFolder = Field(alias="destinationPrefix")
    resume_vendor_job_id: VendorJobId | None = Field(default=None, alias="resumeVendorJobId")

    @model_validator(mode="after")
    def _consistent(self) -> DubRunPayload:
        if self.speakers == 0:
            raise ValueError("speakers is 1-10, or -1")
        if len(set(self.target_languages)) != len(self.target_languages):
            raise ValueError("a language is asked for once")
        if self.source_language in self.target_languages:
            raise ValueError("a clip is not dubbed into its own language")
        return self


class DubCancelPayload(_Strict):
    """``ai.dub@1`` with ``action: "cancel"``: stop a cancelled dub's vendor job."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    action: Literal["cancel"]
    dub_id: Ulid = Field(alias="dubId")
    vendor_job_id: VendorJobId = Field(alias="vendorJobId")


_PAYLOAD: TypeAdapter[DubRunPayload | DubCancelPayload] = TypeAdapter(
    Annotated[DubRunPayload | DubCancelPayload, Field(discriminator="action")]
)


def parse_dub_payload(data: object) -> DubRunPayload | DubCancelPayload:
    """The job's payload, validated. :raises pydantic.ValidationError: when it is not one."""
    return _PAYLOAD.validate_python(data)


class DubAudioFile(_Strict):
    key: DubKey
    content_type: str = Field(alias="contentType", min_length=1, max_length=100)
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=MAX_AUDIO_BYTES)


class DubCaptionsFile(_Strict):
    key: DubKey
    size_bytes: int = Field(alias="sizeBytes", ge=0, le=MAX_CAPTIONS_BYTES)


class DubTrack(_Strict):
    """One language's outcome: both files when ``ready``, why not when ``failed``."""

    language: DubLanguage
    status: Literal["ready", "failed"]
    audio: DubAudioFile | None = None
    captions: DubCaptionsFile | None = None
    reason: str | None = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def _complete(self) -> DubTrack:
        if self.status == "ready" and (self.audio is None or self.captions is None):
            raise ValueError("a ready language carries its audio and its captions")
        return self


class DubRunResult(_Strict):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    action: Literal["dub"]
    dub_id: Ulid = Field(alias="dubId")
    vendor_job_id: VendorJobId = Field(alias="vendorJobId")
    vendor_status: Literal["completed", "partial_failure"] = Field(alias="vendorStatus")
    tracks: list[DubTrack] = Field(min_length=1, max_length=MAX_LANGUAGES)

    @model_validator(mode="after")
    def _one_per_language(self) -> DubRunResult:
        languages = [track.language for track in self.tracks]
        if len(set(languages)) != len(languages):
            raise ValueError("one track per language")
        return self


class DubCancelResult(_Strict):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    action: Literal["cancel"]
    dub_id: Ulid = Field(alias="dubId")
    vendor_job_id: VendorJobId = Field(alias="vendorJobId")
    #: False when the vendor had already finished or forgotten the job.
    cancelled: bool


class DubCheckpoint(_Strict):
    """What the worker records on its job row before it starts the vendor's job."""

    vendor_job_id: VendorJobId = Field(alias="vendorJobId")
    vendor_phase: Literal["created", "uploaded", "started"] = Field(alias="vendorPhase")
