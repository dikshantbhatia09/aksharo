"""D08: shadow-marked candidates and the routing freeze."""

from __future__ import annotations

from pathlib import Path

import pytest

from worker_ai.providers.registry import ProviderRegistry, build_registry
from worker_ai.routing import (
    RoutingError,
    is_routing_frozen,
    load_routing_snapshot,
    load_routing_table,
    load_routing_table_guarded,
    resolve,
    resolve_chain,
    shadow_candidates,
    write_routing_snapshot,
)
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

_SHADOW_TABLE_YAML = (
    "default: global\nlanes:\n"
    "  - id: global\n    languages: []\n"
    "    candidates:\n"
    "      - {provider: mock, model: fixture-v1}\n"
    "      - {provider: sarvam, model: saaras-v4, shadow: true}\n"
)


def _registry() -> ProviderRegistry:
    return build_registry(
        load_settings({**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}'})
    )


# ---------------------------------------------------------------------------
# Shadow
# ---------------------------------------------------------------------------


def test_a_shadow_candidate_is_parsed_and_never_in_the_returned_chain(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(_SHADOW_TABLE_YAML, encoding="utf-8")
    table = load_routing_table(path)

    lane = table.lane("global")
    assert [candidate.provider for candidate in lane.candidates] == ["mock", "sarvam"]
    assert lane.candidates[1].shadow is True

    registry = _registry()
    chain = resolve_chain(table, registry, language="fr")
    assert [decision.candidate.provider for decision in chain] == ["mock"]
    decision = resolve(table, registry, language="fr")
    assert decision.candidate.provider == "mock"


def test_shadow_candidates_lists_only_shadow_rungs_this_deployment_can_run(
    tmp_path: Path,
) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(_SHADOW_TABLE_YAML, encoding="utf-8")
    table = load_routing_table(path)

    # No SARVAM_API_KEY: the shadow candidate cannot actually run here, so the
    # shadow list is empty even though the table names one.
    registry = _registry()
    assert shadow_candidates(table, registry, language="fr") == ()

    # With a key, it becomes runnable — and still never appears in resolve_chain.
    live_registry = build_registry(
        load_settings(
            {**VALID_ENV, "FEATURE_FLAGS_JSON": '{"asr.local-whisper": false}',
             "SARVAM_API_KEY": "sk-not-real"}
        )
    )
    shadows = shadow_candidates(table, live_registry, language="fr")
    assert [candidate.provider for candidate in shadows] == ["sarvam"]
    # The shadow candidate is still never in the *live* chain, even though it is
    # now runnable: with a real vendor configured the mock refuses to stand in,
    # so a table with only a shadow candidate besides the mock is left with
    # nothing it may actually return — proof that "shadow" really means
    # "excluded from resolution", not "ranked last".
    with pytest.raises(RoutingError, match="no provider can serve"):
        resolve(table, live_registry, language="fr")


def test_a_never_route_provider_cannot_be_smuggled_in_as_shadow(tmp_path: Path) -> None:
    path = tmp_path / "routing.yaml"
    path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: bhashini, model: x, shadow: true}]\n",
        encoding="utf-8",
    )
    with pytest.raises(RoutingError, match="Bhashini"):
        load_routing_table(path)


def test_shadow_round_trips_through_to_wire() -> None:
    from worker_ai.routing import RoutingCandidate

    candidate = RoutingCandidate(provider="sarvam", model="saaras-v4", shadow=True)
    assert candidate.to_wire()["shadow"] is True
    assert RoutingCandidate(provider="mock", model="x").to_wire()["shadow"] is False


# ---------------------------------------------------------------------------
# Freeze
# ---------------------------------------------------------------------------


def test_is_routing_frozen_reads_the_env_var() -> None:
    assert is_routing_frozen({}) is False
    assert is_routing_frozen({"ROUTING_FROZEN": "0"}) is False
    assert is_routing_frozen({"ROUTING_FROZEN": "1"}) is True
    assert is_routing_frozen({"ROUTING_FROZEN": "true"}) is True
    assert is_routing_frozen({"ROUTING_FROZEN": "YES"}) is True


def test_an_unfrozen_load_writes_and_a_frozen_load_reads_the_snapshot(tmp_path: Path) -> None:
    routing_path = tmp_path / "routing.yaml"
    routing_path.write_text(_SHADOW_TABLE_YAML, encoding="utf-8")
    snapshot_path = tmp_path / "routing.snapshot.json"

    approved = load_routing_table_guarded(routing_path, frozen=False, snapshot_path=snapshot_path)
    assert snapshot_path.is_file()
    assert approved.lane("global").candidates[0].provider == "mock"

    # The file on disk changes after the snapshot was taken...
    routing_path.write_text(
        "default: global\nlanes:\n"
        "  - id: global\n    languages: []\n"
        "    candidates: [{provider: sarvam, model: saaras-v4}]\n",
        encoding="utf-8",
    )
    # ...but a frozen load never looks at it: it gets the snapshot back, unchanged.
    frozen_table = load_routing_table_guarded(
        routing_path, frozen=True, snapshot_path=snapshot_path
    )
    assert frozen_table.lane("global").candidates[0].provider == "mock"

    # And the un-guarded loader would have picked up the edit, proving the freeze
    # is doing the refusing, not some accident of caching.
    reloaded = load_routing_table(routing_path)
    assert reloaded.lane("global").candidates[0].provider == "sarvam"


def test_freezing_before_any_approved_snapshot_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(RoutingError, match="no approved snapshot"):
        load_routing_snapshot(tmp_path / "missing.json")


def test_write_then_load_snapshot_round_trips_shadow_and_weights(tmp_path: Path) -> None:
    routing_path = tmp_path / "routing.yaml"
    routing_path.write_text(_SHADOW_TABLE_YAML, encoding="utf-8")
    table = load_routing_table(routing_path)
    snapshot_path = tmp_path / "snap.json"

    write_routing_snapshot(table, snapshot_path)
    restored = load_routing_snapshot(snapshot_path)

    assert restored.version == table.version
    assert restored.default_lane_id == table.default_lane_id
    restored_lane = restored.lane("global")
    original_lane = table.lane("global")
    assert [c.provider for c in restored_lane.candidates] == [
        c.provider for c in original_lane.candidates
    ]
    assert restored_lane.candidates[1].shadow is True
