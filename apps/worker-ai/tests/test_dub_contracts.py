"""``ai.dub@1`` parity: the Python mirror and the TypeScript contract (2026-10-04).

Both sides parse the SAME fixture files in ``packages/repurpose-contracts/fixtures``
and assert the same literal field lists as ``src/dubbing.test.ts``, so a field
added on one side and not the other fails a test on both.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from worker_ai.dubbing.contracts import (
    CLIP_VIDEO_KEY_PATTERN,
    DUB_FOLDER_PATTERN,
    DUB_KEY_PATTERN,
    DUB_LANGUAGES,
    DubCancelPayload,
    DubCancelResult,
    DubCheckpoint,
    DubRunPayload,
    DubRunResult,
    DubTrack,
    parse_dub_payload,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "packages" / "repurpose-contracts" / "fixtures"
DUBBING_TS = REPO_ROOT / "packages" / "repurpose-contracts" / "src" / "dubbing.ts"

# The same literals `packages/repurpose-contracts/src/dubbing.test.ts` asserts.
RUN_PAYLOAD_FIELDS = [
    "action",
    "clipId",
    "destinationPrefix",
    "dubId",
    "durationMs",
    "resumeVendorJobId",
    "runId",
    "schemaVersion",
    "source",
    "sourceLanguage",
    "speakers",
    "targetLanguages",
]
RUN_RESULT_FIELDS = ["action", "dubId", "schemaVersion", "tracks", "vendorJobId", "vendorStatus"]


def fixture(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def test_parses_the_shared_payload_fixtures() -> None:
    payload = parse_dub_payload(fixture("ai-dub-payload.v1.json"))
    assert isinstance(payload, DubRunPayload)
    assert payload.target_languages == ["hi-IN", "ta-IN"]
    assert payload.resume_vendor_job_id == "5f0c2d6e-8a1b-4c3d-9e7f-0a1b2c3d4e5f"
    assert sorted(fixture("ai-dub-payload.v1.json")) == RUN_PAYLOAD_FIELDS
    assert (
        sorted(
            DubRunPayload.model_fields[name].alias or name for name in DubRunPayload.model_fields
        )
        == RUN_PAYLOAD_FIELDS
    )
    cancel = parse_dub_payload(fixture("ai-dub-cancel-payload.v1.json"))
    assert isinstance(cancel, DubCancelPayload)


def test_round_trips_the_result_fixtures_unchanged() -> None:
    for name, model in (
        ("ai-dub-result.v1.json", DubRunResult),
        ("ai-dub-cancel-result.v1.json", DubCancelResult),
    ):
        source = fixture(name)
        assert model.model_validate(source).to_wire() == source
    assert sorted(fixture("ai-dub-result.v1.json")) == RUN_RESULT_FIELDS


def test_reads_only_a_clips_clean_video() -> None:
    payload = fixture("ai-dub-payload.v1.json")
    captioned = (
        "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/p/01ARZ3NDEKTSV4RRFFQ69G5FAX"
        "/exports/01JCEXP0RT0000000000000000.mp4"
    )
    with pytest.raises(ValidationError):
        parse_dub_payload({**payload, "source": {"key": captioned, "contentType": "video/mp4"}})


@pytest.mark.parametrize(
    "change",
    [
        {"targetLanguages": ["en-IN", "hi-IN"]},
        {"targetLanguages": ["hi-IN", "hi-IN"]},
        {"targetLanguages": []},
        {"targetLanguages": ["od-IN"]},
        {"speakers": 0},
        {"speakers": 11},
        {"resumeVendorJobId": "../x"},
        {"unknown": True},
    ],
)
def test_refuses_what_the_typescript_schema_refuses(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        parse_dub_payload({**fixture("ai-dub-payload.v1.json"), **change})


def test_a_ready_language_carries_both_files() -> None:
    with pytest.raises(ValidationError):
        DubTrack.model_validate({"language": "hi-IN", "status": "ready"})


def test_the_checkpoint_is_the_one_the_api_stores() -> None:
    point = DubCheckpoint.model_validate({"vendorJobId": "abc-1", "vendorPhase": "created"})
    assert point.to_wire() == {"vendorJobId": "abc-1", "vendorPhase": "created"}
    with pytest.raises(ValidationError):
        DubCheckpoint.model_validate({"vendorJobId": "abc", "vendorPhase": "done"})


def test_the_patterns_are_the_typescript_ones_character_for_character() -> None:
    """The regex literals in `dubbing.ts`, with their escaped slashes unescaped."""
    source = DUBBING_TS.read_text(encoding="utf-8")

    def literal(name: str) -> str:
        match = re.search(rf"export const {name} =\s*/(.+)/;", source)
        assert match is not None, name
        return match.group(1).replace("\\/", "/")

    assert literal("DUB_FOLDER_PATTERN") == DUB_FOLDER_PATTERN
    assert literal("DUB_KEY_PATTERN") == DUB_KEY_PATTERN
    assert literal("CLIP_VIDEO_KEY_PATTERN") == CLIP_VIDEO_KEY_PATTERN
    languages = re.search(r"export const DUB_LANGUAGES = \[(.*?)\] as const;", source, re.S)
    assert languages is not None
    assert tuple(re.findall(r'"([a-z]{2}-IN)"', languages.group(1))) == DUB_LANGUAGES
