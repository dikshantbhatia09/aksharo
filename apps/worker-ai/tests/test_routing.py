"""The v2 routing table (D12) and how it is resolved against a deployment."""

from __future__ import annotations

from pathlib import Path

import pytest

from worker_ai.providers.registry import ProviderRegistry, build_registry
from worker_ai.routing import (
    DEFAULT_ROUTING_FILE,
    NEVER_ROUTE,
    RoutingError,
    load_overrides,
    load_routing_table,
    resolve,
    resolve_chain,
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
    # The lane's own candidates first, then the default lane's; a provider is
    # only reported once, however many lanes name it.
    assert [provider for provider, _ in decision.skipped] == [
        "sarvam",
        "elevenlabs",
        "serverless-whisper",
        "assemblyai",
        "local-whisper",
    ]
    assert decision.needs_alignment is False


def test_a_gpu_deployment_routes_hinglish_to_the_serverless_fallback() -> None:
    """With no vendor key, the GPU lane is the first thing that can run."""
    registry = build_registry(
        load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.example"})
    )
    decision = resolve(TABLE, registry, language="hi-en")

    assert decision.lane.id == "hinglish"
    assert decision.candidate.provider == "serverless-whisper"
    assert decision.candidate.model == "large-v3-turbo"
    assert decision.to_wire()["skipped"][0] == {
        "provider": "sarvam",
        "reason": "SARVAM_API_KEY is not set",
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


# ---------------------------------------------------------------------------
# A10: the fallback chain, admin overrides and the never-route list
# ---------------------------------------------------------------------------


def _registry(**env: str) -> ProviderRegistry:
    from worker_ai.providers.registry import build_registry

    return build_registry(
        load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}', **env})
    )


ALL_KEYS = {
    "SARVAM_API_KEY": "sk-not-real",
    "ELEVENLABS_API_KEY": "xi-not-real",
    "ASSEMBLYAI_API_KEY": "aai-not-real",
    "GPU_PROVIDER_URL": "https://gpu.example",
}


@pytest.mark.parametrize(
    ("language", "code_mix", "lane", "provider", "alignment"),
    [
        # Acceptance 2, one row each.
        (None, True, "hinglish", "sarvam", "required"),
        ("hi", False, "hindi", "elevenlabs", "optional"),
        ("ur", False, "indic-sarvam", "sarvam", "required"),
        ("doi", False, "indic-sarvam", "sarvam", "required"),
        ("en-IN", False, "indian-english", "elevenlabs", "optional"),
        ("ta", False, "indic-scribe", "elevenlabs", "optional"),
        ("fr", False, "global", "serverless-whisper", "optional"),
        ("de", False, "global", "serverless-whisper", "optional"),
    ],
)
def test_a_fully_configured_deployment_routes_the_d12_table(
    language: str | None, code_mix: bool, lane: str, provider: str, alignment: str
) -> None:
    decision = resolve(TABLE, _registry(**ALL_KEYS), language=language, code_mix=code_mix)
    assert (decision.lane.id, decision.candidate.provider) == (lane, provider)
    assert decision.candidate.alignment == alignment
    assert decision.needs_alignment is (alignment == "required")


def test_the_chain_is_the_lane_then_the_default_lane() -> None:
    """`09 §1`: fallback on provider error walks this list, primary first."""
    chain = resolve_chain(TABLE, _registry(**ALL_KEYS), language="hi")
    assert [decision.candidate.provider for decision in chain] == [
        "elevenlabs",
        "sarvam",
        "serverless-whisper",
        # Borrowed from the default lane: Universal-2 declares no closed language
        # list, so it can serve Hindi when the whole Hindi lane is down.
        "assemblyai",
    ]
    assert [decision.rank for decision in chain] == [0, 1, 2, 3]
    assert chain[0].is_fallback is False
    assert chain[1].is_fallback is True


def test_a_provider_appears_once_however_many_lanes_name_it() -> None:
    chain = resolve_chain(TABLE, _registry(**ALL_KEYS), language="hi-en")
    providers = [decision.candidate.provider for decision in chain]
    assert len(providers) == len(set(providers))


def test_a_disabled_provider_is_never_selected() -> None:
    """Acceptance 2: the flag is the operator's kill switch."""
    registry = _registry(**ALL_KEYS, FEATURE_FLAGS_JSON='{"asr.elevenlabs": false}')
    chain = resolve_chain(TABLE, registry, language="hi")
    assert "elevenlabs" not in [decision.candidate.provider for decision in chain]
    assert chain[0].candidate.provider == "sarvam"
    assert ("elevenlabs", "feature flag asr.elevenlabs is off") in chain[0].skipped


def test_a_candidate_switched_off_in_the_table_is_skipped(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n    candidates:\n"
        "      - {provider: assemblyai, model: universal-2, enabled: false}\n"
        "      - {provider: serverless-whisper, model: large-v3-turbo}\n",
        encoding="utf-8",
    )
    decision = resolve(load_routing_table(path), _registry(**ALL_KEYS), language="fr")
    assert decision.candidate.provider == "serverless-whisper"
    assert decision.skipped[0][1].startswith("the routing table has this candidate")


def test_a_borrowed_candidate_that_cannot_cover_the_language_is_skipped(
    tmp_path: Path,
) -> None:
    """A Dogri job whose lane is down must not land on an adapter without it.

    Inside its own lane the table is the authority — D12 puts Scribe behind
    Saaras for ur/sd deliberately. A candidate *borrowed* from the default lane
    made no such claim, so there its declared coverage is checked.
    """
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: scribe-only\nlanes:\n"
        "  - id: uncovered\n    languages: [doi]\n"
        "    candidates: [{provider: sarvam, model: saaras-v4, alignment: required}]\n"
        "  - id: scribe-only\n    languages: [hi]\n"
        "    candidates: [{provider: elevenlabs, model: scribe-v2}]\n",
        encoding="utf-8",
    )
    table = load_routing_table(path)
    registry = _registry(ELEVENLABS_API_KEY="xi-not-real", WORKER_AI_ALLOW_MOCK="0")
    with pytest.raises(RoutingError, match="does not cover doi"):
        resolve(table, registry, language="doi")
    # The same adapter serves the language it does declare.
    assert resolve(table, registry, language="hi").candidate.provider == "elevenlabs"


def test_the_batch_flag_is_readable_from_the_candidate() -> None:
    assert TABLE.lane("hinglish").candidates[0].batch is True
    assert TABLE.lane("hindi").candidates[0].batch is False


def test_bhashini_cannot_be_routed_to(tmp_path: Path) -> None:
    """RR-02 F3 / D63: proof-of-concept-only terms, enforced at load time."""
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: bhashini, model: ulca}]\n",
        encoding="utf-8",
    )
    with pytest.raises(RoutingError, match="proof-of-concept only"):
        load_routing_table(path)
    assert "bhashini" in NEVER_ROUTE


# ---------------------------------------------------------------------------
# Admin overrides (`09 §1`: the weights the admin console edits)
# ---------------------------------------------------------------------------


def test_overrides_reorder_a_lane_by_weight() -> None:
    table = TABLE.apply_overrides(
        {"lanes": {"hinglish": {"candidates": {"elevenlabs": {"weight": 200}}}}}
    )
    assert table.lane("hinglish").candidates[0].provider == "elevenlabs"
    assert table.overrides_applied is True
    # The packaged table is untouched: overrides return a copy.
    assert TABLE.lane("hinglish").candidates[0].provider == "sarvam"


def test_overrides_can_switch_a_candidate_off_and_reprice_it() -> None:
    table = TABLE.apply_overrides(
        {
            "lanes": {
                "hindi": {
                    "candidates": {
                        "elevenlabs": {"enabled": False, "costPerMinuteInr": 0.42},
                        "sarvam": {"weight": 10, "maxParallelChunks": 2},
                    }
                }
            }
        }
    )
    lane = table.lane("hindi")
    scribe = next(item for item in lane.candidates if item.provider == "elevenlabs")
    saaras = next(item for item in lane.candidates if item.provider == "sarvam")
    assert scribe.enabled is False
    assert scribe.cost_per_minute_inr == pytest.approx(0.42)
    assert saaras.max_parallel_chunks == 2
    # Order still follows weight; the switched-off row is skipped at resolution.
    assert lane.candidates[0].provider == "elevenlabs"
    assert resolve(table, _registry(**ALL_KEYS), language="hi").candidate.provider == "sarvam"


def test_an_override_for_an_unknown_lane_or_key_changes_nothing() -> None:
    assert TABLE.apply_overrides({"lanes": {"klingon": {"candidates": {}}}}) is TABLE
    assert TABLE.apply_overrides({}) is TABLE
    assert TABLE.apply_overrides({"lanes": "nonsense"}) is TABLE


def test_a_malformed_override_value_is_ignored_rather_than_crashing() -> None:
    table = TABLE.apply_overrides(
        {"lanes": {"hindi": {"candidates": {"elevenlabs": {"weight": "lots", "enabled": 1}}}}}
    )
    scribe = next(
        item for item in table.lane("hindi").candidates if item.provider == "elevenlabs"
    )
    assert scribe.weight == 100
    assert scribe.enabled is True


@pytest.mark.parametrize("raw", ["", "   ", "not json", "[1,2]", None])
def test_a_broken_overrides_variable_means_no_overrides(raw: str | None) -> None:
    """A tuning knob must never stop a worker booting."""
    assert load_overrides(raw) == {}


def test_overrides_parse_from_the_environment_variable() -> None:
    assert load_overrides('{"lanes": {"hindi": {}}}') == {"lanes": {"hindi": {}}}


def test_the_worker_lays_the_environment_overrides_over_the_file() -> None:
    from worker_ai.runtime import build_routing_table

    settings = load_settings(
        {
            **VALID_ENV,
            "ROUTING_OVERRIDES_JSON": (
                '{"lanes": {"hinglish": {"candidates": {"elevenlabs": {"weight": 500}}}}}'
            ),
        }
    )
    table = build_routing_table(settings)
    assert table.lane("hinglish").candidates[0].provider == "elevenlabs"


def test_the_worker_boots_without_any_overrides() -> None:
    from worker_ai.runtime import build_routing_table

    table = build_routing_table(load_settings(VALID_ENV))
    assert table.overrides_applied is False
    assert table.lane("hinglish").candidates[0].provider == "sarvam"


def test_a_missing_internal_routing_endpoint_is_not_an_error() -> None:
    """B13 owns `GET /internal/routing`; it does not exist on main yet."""
    import httpx2

    from worker_ai.runtime import fetch_routing_overrides

    settings = load_settings(
        {**VALID_ENV, "WORKER_AI_ROUTING_OVERRIDES_FROM_API": "1", "API_ORIGIN": "http://api.invalid"}
    )
    # No server is listening on api.invalid, which is the same outcome as a 404.
    assert isinstance(fetch_routing_overrides(settings), dict)
    assert fetch_routing_overrides(settings) == {}
    del httpx2
