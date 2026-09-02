"""The v2 routing table (D12) and how it is resolved against a deployment."""

from __future__ import annotations

from pathlib import Path

import pytest

from worker_ai.providers.registry import build_registry
from worker_ai.routing import (
    DEFAULT_ROUTING_FILE,
    RoutingError,
    load_routing_table,
    resolve,
)
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

TABLE = load_routing_table()


def test_the_packaged_table_is_the_v2_table_from_the_pipeline_document() -> None:
    assert TABLE.version == 2
    assert TABLE.default_lane_id == "global"
    assert [lane.id for lane in TABLE.lanes] == [
        "hinglish",
        "hindi",
        "indian-english",
        "indic-scribe",
        "indic-sarvam",
        "global",
    ]
    assert DEFAULT_ROUTING_FILE.is_file()


def test_the_hinglish_lane_is_sarvam_codemix_batch_with_mandatory_alignment() -> None:
    """D12: Saaras gives chunk-level timestamps only, so alignment is required."""
    primary = TABLE.lane("hinglish").candidates[0]
    assert (primary.provider, primary.model) == ("sarvam", "saaras-v4")
    assert primary.mode == "codemix"
    assert primary.api == "batch"
    assert primary.alignment == "required"
    assert primary.provider_options() == {"mode": "codemix", "api": "batch"}


def test_every_scribe_lane_keeps_word_timestamps_optional() -> None:
    for lane_id in ("hindi", "indian-english", "indic-scribe"):
        primary = TABLE.lane(lane_id).candidates[0]
        assert primary.alignment == "optional", lane_id


def test_the_uncovered_languages_route_to_sarvam() -> None:
    assert TABLE.lane_for("ur").id == "indic-sarvam"
    assert TABLE.lane_for("doi").id == "indic-sarvam"


@pytest.mark.parametrize(
    ("language", "lane"),
    [
        ("hi-en", "hinglish"),
        ("hi", "hindi"),
        ("hi-IN", "hindi"),
        ("en-IN", "indian-english"),
        ("ta", "indic-scribe"),
        # A region subtag falls back to its base language.
        ("ta-IN", "indic-scribe"),
        ("TA", "indic-scribe"),
        ("fr", "global"),
        (None, "global"),
        ("", "global"),
    ],
)
def test_lane_selection(language: str | None, lane: str) -> None:
    assert TABLE.lane_for(language).id == lane


def test_a_code_mix_signal_wins_over_the_language_tag() -> None:
    """A two-signal LID agreement (D14) is the only way this flag is set."""
    assert TABLE.lane_for("hi", code_mix=True).id == "hinglish"
    assert TABLE.lane_for("en", code_mix=True).id == "hinglish"


def test_an_unknown_lane_is_an_error() -> None:
    with pytest.raises(RoutingError, match="no lane"):
        TABLE.lane("klingon")


def test_the_table_serialises_for_the_control_app() -> None:
    wire = TABLE.to_wire()
    assert wire["version"] == 2
    assert wire["default"] == "global"
    hinglish = next(lane for lane in wire["lanes"] if lane["id"] == "hinglish")
    assert hinglish["codeMix"] is True
    assert hinglish["candidates"][0]["costPerMinuteInr"] == pytest.approx(0.53)


# ---------------------------------------------------------------------------
# Loading errors
# ---------------------------------------------------------------------------


def test_a_missing_file_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(RoutingError, match="could not read"):
        load_routing_table(tmp_path / "nope.yaml")


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("- not a mapping", "must hold a mapping"),
        ("version: 2\nlanes: []", "at least one lane"),
        ("lanes:\n  - label: x\n", "every lane needs an id"),
        ("lanes:\n  - id: a\n", "has no candidates"),
        ("lanes:\n  - id: a\n    candidates: [{model: x}]", "without a provider"),
        (
            "lanes:\n  - id: a\n    candidates: [{provider: p, alignment: maybe}]",
            "unknown alignment policy",
        ),
        (
            "default: nowhere\nlanes:\n  - id: a\n    candidates: [{provider: p}]",
            "does not exist",
        ),
        (
            "lanes:\n  - id: a\n    languages: 5\n    candidates: [{provider: p}]",
            "malformed language list",
        ),
    ],
)
def test_a_malformed_table_names_what_is_wrong(tmp_path: Path, body: str, message: str) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(RoutingError, match=message):
        load_routing_table(path)


def test_duplicate_lane_ids_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: a\nlanes:\n"
        "  - id: a\n    candidates: [{provider: p}]\n"
        "  - id: a\n    candidates: [{provider: q}]\n",
        encoding="utf-8",
    )
    with pytest.raises(RoutingError, match="duplicate lane ids"):
        load_routing_table(path)


def test_invalid_yaml_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text("lanes: [\n", encoding="utf-8")
    with pytest.raises(RoutingError, match="not valid YAML"):
        load_routing_table(path)


# ---------------------------------------------------------------------------
# Resolution against a deployment
# ---------------------------------------------------------------------------


def test_a_bare_deployment_falls_through_the_lane_to_the_mock() -> None:
    """No vendor keys, no GPU: every candidate is skipped and the reasons are kept.

    ``local-whisper`` is flagged off so the outcome does not depend on whether the
    optional ``local-asr`` extra happens to be installed on the machine running
    the suite.
    """
    registry = build_registry(
        load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}'})
    )
    decision = resolve(TABLE, registry, language="hi-en")

    assert decision.lane.id == "hinglish"
    assert decision.candidate.provider == "mock"
    # The lane's own candidates first, then the default lane's.
    assert [provider for provider, _ in decision.skipped] == [
        "sarvam",
        "elevenlabs",
        "serverless-whisper",
        "serverless-whisper",
        "assemblyai",
        "local-whisper",
    ]
    assert decision.needs_alignment is False


def test_a_gpu_deployment_routes_hinglish_to_the_serverless_fallback() -> None:
    """Sarvam and Scribe are A10; the GPU lane is the first thing that can run."""
    registry = build_registry(
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example"})
    )
    decision = resolve(TABLE, registry, language="hi-en")

    assert decision.lane.id == "hinglish"
    assert decision.candidate.provider == "serverless-whisper"
    assert decision.candidate.model == "large-v3-turbo"
    assert decision.to_wire()["skipped"][0] == {
        "provider": "sarvam",
        "reason": "the adapter lands in A10",
    }


def test_resolution_falls_back_to_the_default_lane_before_the_mock(tmp_path: Path) -> None:
    """A lane whose candidates are all unavailable borrows the default lane's."""
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: hinglish\n    codeMix: true\n    languages: [hi-en]\n"
        "    candidates: [{provider: sarvam, model: saaras-v4, alignment: required}]\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: serverless-whisper, model: large-v3-turbo}]\n",
        encoding="utf-8",
    )
    table = load_routing_table(path)
    registry = build_registry(
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example"})
    )
    decision = resolve(table, registry, language="hi-en")

    assert decision.lane.id == "hinglish"
    assert decision.candidate.provider == "serverless-whisper"


def test_nothing_available_and_no_mock_is_an_error(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: sarvam, model: saaras-v4}]\n",
        encoding="utf-8",
    )
    registry = build_registry(load_settings({**VALID_ENV, "WORKER_AI_ALLOW_MOCK": "0"}))
    with pytest.raises(RoutingError, match="no provider can serve lane 'global'"):
        resolve(load_routing_table(path), registry, language="fr")


def test_a_candidate_that_cannot_transcribe_is_skipped(tmp_path: Path) -> None:
    """`local-whisper` does not align, so an alignment lane must pass it over."""
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: mock, model: fixture-v1}]\n",
        encoding="utf-8",
    )
    registry = build_registry(load_settings(VALID_ENV))
    decision = resolve(load_routing_table(path), registry, language="fr")
    assert decision.candidate.provider == "mock"
