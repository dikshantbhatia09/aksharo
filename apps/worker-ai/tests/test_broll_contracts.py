"""``ai.llm`` kind ``broll`` parity: the Python mirror and the TypeScript contract (2026-10-05).

Both sides parse the SAME fixture files in ``packages/repurpose-contracts/fixtures``
and assert the same literal field lists as ``src/broll.test.ts``, so a field
added on one side and not the other fails a test on both.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from worker_ai.llm.broll_contracts import (
    BROLL_LLM_KIND,
    BROLL_TEMPLATE_VERSION,
    MAX_MOMENTS,
    PHRASE_MAX,
    BrollMoment,
    BrollOutput,
    BrollRequest,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "packages" / "repurpose-contracts" / "fixtures"
BROLL_TS = REPO_ROOT / "packages" / "repurpose-contracts" / "src" / "broll.ts"

# The same literals `packages/repurpose-contracts/src/broll.test.ts` asserts.
REQUEST_FIELDS = [
    "avoid",
    "language",
    "maxMoments",
    "minGapMs",
    "schemaVersion",
    "title",
    "words",
]
MOMENT_FIELDS = ["endMs", "endWordId", "phrase", "score", "spoken", "startMs", "startWordId"]
OUTPUT_FIELDS = ["moments", "schemaVersion", "source"]


def fixture(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def fields(model: type[Any]) -> list[str]:
    return sorted(model.model_fields[name].alias or name for name in model.model_fields)


def test_parses_the_shared_fixtures_field_for_field() -> None:
    request = BrollRequest.model_validate(fixture("ai-llm-broll-request.v1.json"))
    assert request.language == "hi-Latn"
    assert len(request.words) == 16
    assert request.max_moments == 4
    assert sorted(fixture("ai-llm-broll-request.v1.json")) == REQUEST_FIELDS
    assert fields(BrollRequest) == REQUEST_FIELDS
    assert fields(BrollMoment) == MOMENT_FIELDS
    assert fields(BrollOutput) == OUTPUT_FIELDS


def test_round_trips_the_output_fixture_unchanged() -> None:
    raw = fixture("ai-llm-broll-output.v1.json")
    parsed = BrollOutput.model_validate(raw)
    assert parsed.model_dump(by_alias=True, mode="json") == raw


@pytest.mark.parametrize(
    "change",
    [
        {"extra": True},
        {"schemaVersion": 2},
        {"words": []},
        {"words": [{"id": "zero", "t": "x", "s": 0, "e": 1}]},
        {"words": [{"id": "0:0", "t": "x", "s": 10, "e": 5}]},
        {"maxMoments": MAX_MOMENTS + 1},
        {"avoid": [{"startMs": 5, "endMs": 5}]},
        {"language": " "},
    ],
)
def test_refuses_what_the_typescript_side_refuses(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        BrollRequest.model_validate({**fixture("ai-llm-broll-request.v1.json"), **change})


def test_refuses_an_output_the_api_would_refuse() -> None:
    raw = fixture("ai-llm-broll-output.v1.json")
    first = raw["moments"][0]
    for bad in (
        {**raw, "source": "rules"},
        {**raw, "moments": [{**first, "score": 11}]},
        {**raw, "moments": [{**first, "phrase": "x"}]},
        {**raw, "moments": [{**first, "phrase": "y" * (PHRASE_MAX + 1)}]},
        {**raw, "moments": [first] * (MAX_MOMENTS + 1)},
    ):
        with pytest.raises(ValidationError):
            BrollOutput.model_validate(bad)


def test_its_constants_match_the_typescript_ones() -> None:
    source = BROLL_TS.read_text(encoding="utf-8")
    assert f'BROLL_LLM_KIND = "{BROLL_LLM_KIND}"' in source
    assert f'BROLL_TEMPLATE_VERSION = "{BROLL_TEMPLATE_VERSION}"' in source
    assert re.search(rf"maxMoments: {MAX_MOMENTS},", source) is not None
    assert re.search(rf"phraseMax: {PHRASE_MAX},", source) is not None
