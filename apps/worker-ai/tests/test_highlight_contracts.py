"""``ai.highlights@1`` parity: the Python mirror and the TypeScript contract.

Both sides parse the SAME fixture files, and both assert the same literal field
lists. A field added to ``packages/repurpose-contracts/src/jobs.ts`` without being
added here fails ``test_payload_has_exactly_the_typescript_fields``; a field added
here without the fixture fails ``extra="forbid"``. That is the cross-runtime guard
REP-005 asks for — a name that exists on one side only cannot pass silently.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from worker_ai.highlights import (
    HighlightProposal,
    HighlightsPayload,
    HighlightsResult,
    highlights_job_key,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "packages" / "repurpose-contracts" / "fixtures"

# The same literals `packages/repurpose-contracts/src/jobs.test.ts` asserts.
PAYLOAD_FIELDS = [
    "featureVersion",
    "options",
    "projectId",
    "promptVersion",
    "proxy",
    "runId",
    "schemaVersion",
    "transcriptId",
    "transcriptRevision",
    "waveform",
]
RESULT_FIELDS = [
    "featureVersion",
    "model",
    "promptVersion",
    "proposals",
    "runId",
    "schemaVersion",
    "transcriptId",
    "transcriptRevision",
    "windowsConsidered",
]
PROPOSAL_FIELDS = [
    "endMs",
    "endWordId",
    "potentialScore",
    "reasons",
    "scoreBreakdown",
    "startMs",
    "startWordId",
    "title",
    "transcriptExcerpt",
    "windowId",
]


def fixture(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return loaded


def test_parses_the_shared_payload_fixture() -> None:
    payload = HighlightsPayload.model_validate(fixture("ai-highlights-payload.v1.json"))
    assert payload.transcript_revision == 3
    assert payload.options.language == "hi-Latn"
    assert payload.waveform is not None


def test_parses_the_shared_result_fixture() -> None:
    result = HighlightsResult.model_validate(fixture("ai-highlights-result.v1.json"))
    assert len(result.proposals) == 1
    assert result.proposals[0].window_id == "w-0042"
    assert result.proposals[0].score_breakdown.standalone_value == 83


def test_payload_has_exactly_the_typescript_fields() -> None:
    assert sorted(fixture("ai-highlights-payload.v1.json")) == PAYLOAD_FIELDS


def test_the_model_declares_exactly_those_fields_too() -> None:
    """Check the SCHEMA, not just the fixture it happens to parse.

    Asserting the fixture's key list alone proves nothing about either side's
    model: a field could be added to the Pydantic mirror and to the TypeScript
    schema as optional, and both suites would still pass with the old fixture. The
    aliases this model declares ARE its wire contract, so they are what must match.
    """
    aliases = sorted(
        (field.alias or name) for name, field in HighlightsPayload.model_fields.items()
    )
    assert aliases == PAYLOAD_FIELDS

    result_aliases = sorted(
        (field.alias or name) for name, field in HighlightsResult.model_fields.items()
    )
    assert result_aliases == RESULT_FIELDS

    proposal_aliases = sorted(
        (field.alias or name) for name, field in HighlightProposal.model_fields.items()
    )
    assert proposal_aliases == PROPOSAL_FIELDS


def test_result_has_exactly_the_typescript_fields() -> None:
    result = fixture("ai-highlights-result.v1.json")
    assert sorted(result) == RESULT_FIELDS
    assert sorted(result["proposals"][0]) == PROPOSAL_FIELDS


def test_round_trips_the_result_without_changing_it() -> None:
    """What Python emits must be what TypeScript accepts, key for key."""
    source = fixture("ai-highlights-result.v1.json")
    parsed = HighlightsResult.model_validate(source)
    assert json.loads(parsed.model_dump_json(by_alias=True)) == source


def test_rejects_an_unknown_field() -> None:
    source = fixture("ai-highlights-payload.v1.json") | {"model": "sneaky"}
    with pytest.raises(ValidationError):
        HighlightsPayload.model_validate(source)


def test_rejects_a_proposal_without_a_window_id() -> None:
    source = fixture("ai-highlights-result.v1.json")
    del source["proposals"][0]["windowId"]
    with pytest.raises(ValidationError):
        HighlightsResult.model_validate(source)


def test_rejects_a_proposal_without_a_reason() -> None:
    source = fixture("ai-highlights-result.v1.json")
    source["proposals"][0]["reasons"] = []
    with pytest.raises(ValidationError):
        HighlightsResult.model_validate(source)


@pytest.mark.parametrize("end_ms", [330_500, 600_000])
def test_rejects_a_proposal_outside_the_hard_duration_limits(end_ms: int) -> None:
    source = fixture("ai-highlights-result.v1.json")
    source["proposals"][0]["endMs"] = end_ms
    with pytest.raises(ValidationError):
        HighlightsResult.model_validate(source)


def test_accepts_an_empty_proposal_list_rather_than_padding() -> None:
    source = fixture("ai-highlights-result.v1.json") | {"proposals": []}
    assert HighlightsResult.model_validate(source).proposals == ()


def test_rejects_a_duration_range_that_is_inverted() -> None:
    source = fixture("ai-highlights-payload.v1.json")
    source["options"]["minDurationMs"] = 90_000
    with pytest.raises(ValidationError):
        HighlightsPayload.model_validate(source)


@pytest.mark.parametrize(
    "bad_id",
    [
        "../../../etc/passwd",
        "01arz3ndektsv4rrffq69g5fav",  # lower case is not Crockford base32
        "01ARZ3NDEKTSV4RRFFQ69G5FA",  # 25 characters
        "01ARZ3NDEKTSV4RRFFQ69G5FAVV",  # 27
        "01ARZ3NDEKTSV4RRFFQ69G5FAI",  # I is excluded from the alphabet
    ],
)
def test_rejects_an_id_that_is_not_a_ulid(bad_id: str) -> None:
    """A length check alone would let traversal and a wrong alphabet through.

    These values reach storage keys and database lookups, and the TypeScript
    contract pins the full Crockford pattern - so this side must too.
    """
    source = fixture("ai-highlights-payload.v1.json")
    source["runId"] = bad_id
    with pytest.raises(ValidationError):
        HighlightsPayload.model_validate(source)


@pytest.mark.parametrize(
    "bad_key",
    [
        "ws/a/p/b/../../../etc/passwd",
        "/absolute/key.mp4",
        "ws\\a\\p\\b\\raw.mp4",
        "",
    ],
)
def test_rejects_a_storage_key_that_escapes_its_prefix(bad_key: str) -> None:
    source = fixture("ai-highlights-payload.v1.json")
    source["proxy"] = {"bucket": "r2", "key": bad_key}
    with pytest.raises(ValidationError):
        HighlightsPayload.model_validate(source)


def test_treats_a_whitespace_only_string_the_way_zod_does() -> None:
    """Zod trims BEFORE measuring; Pydantic measures raw unless told otherwise.

    Without `strip_whitespace` a title of three spaces passes here and fails on the
    TypeScript side - the exact class of drift the parity guard exists to stop.
    """
    source = fixture("ai-highlights-result.v1.json")
    source["proposals"][0]["title"] = "   "
    with pytest.raises(ValidationError):
        HighlightsResult.model_validate(source)


def test_job_key_matches_the_typescript_helper() -> None:
    assert (
        highlights_job_key("01ARZ3NDEKTSV4RRFFQ69G5FAV", "T1", 3, "cfg")
        == "ai.highlights:01ARZ3NDEKTSV4RRFFQ69G5FAV:T1:3:cfg"
    )


def test_job_key_changes_with_the_transcript_revision() -> None:
    first = highlights_job_key("R", "T", 3, "cfg")
    second = highlights_job_key("R", "T", 4, "cfg")
    assert first != second
