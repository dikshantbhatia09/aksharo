from __future__ import annotations

from aksharo_core_app.motion_presets import (
    SUPPORTED_PRESETS,
    default_preset_for_intent,
    is_motion_preset_supported,
    resolve_motion_preset_params,
)

ALL_PRESETS = ("pop", "slide-up", "typewriter", "underline", "count-up", "fade")


def test_supports_every_d06_preset() -> None:
    for preset in ALL_PRESETS:
        assert is_motion_preset_supported(preset) is True
    assert frozenset(ALL_PRESETS) == SUPPORTED_PRESETS


def test_maps_each_intent_to_a_sensible_default_preset() -> None:
    assert default_preset_for_intent("title") == "pop"
    assert default_preset_for_intent("stat") == "count-up"
    assert default_preset_for_intent("quote") == "fade"
    assert default_preset_for_intent("hook") == "slide-up"


def test_uses_the_presets_own_position_y_when_no_layout_hint_is_given() -> None:
    params = resolve_motion_preset_params("pop", None)
    assert params.position_y == 20
    assert params.motion_preset == "pop"


def test_lets_the_layout_candidate_override_the_preset_default() -> None:
    params = resolve_motion_preset_params("pop", "centre")
    assert params.position_y == 50
