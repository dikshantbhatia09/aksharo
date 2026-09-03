"""`TitlePayload.motionPreset` -> Text+ macro param mapping (D09 brief §Scope 2). Python port of
`plugins/shared-apply/src/motionPresets.ts`'s static tables — a small, stable data table (six D06
presets, four layout candidates, four intent defaults), not the plan-building/licence logic
(`apply_plan.py`'s module docstring explains why *that* stays TS-only). Any future preset added
here should be added to the TS table in the same change, and vice versa — this port existing at
all is the honest cost of Resolve having no way to `require()` the TS module directly (unlike
`plugins/premiere-uxp`, which imports `@montaj/shared-apply` verbatim).
"""

from __future__ import annotations

from dataclasses import dataclass

MotionPreset = str  # "pop" | "slide-up" | "typewriter" | "underline" | "count-up" | "fade"
LayoutCandidate = str  # "top-third" | "upper-left" | "upper-right" | "centre"
TitleIntent = str  # "title" | "stat" | "quote" | "hook"


@dataclass(frozen=True, slots=True)
class MotionPresetParams:
    position_y: float
    motion_preset: str
    highlight_start: float
    highlight_end: float


_BASE: dict[str, MotionPresetParams] = {
    "pop": MotionPresetParams(20, "pop", 0, 100),
    "slide-up": MotionPresetParams(30, "slide-up", 0, 100),
    "typewriter": MotionPresetParams(20, "typewriter", 0, 100),
    "underline": MotionPresetParams(25, "underline", 0, 0),
    "count-up": MotionPresetParams(20, "count-up", 0, 100),
    "fade": MotionPresetParams(20, "fade", 0, 100),
}

_CANDIDATE_POSITION_Y: dict[str, float] = {
    "top-third": 15,
    "upper-left": 20,
    "upper-right": 20,
    "centre": 50,
}

_INTENT_DEFAULT_PRESET: dict[str, str] = {
    "title": "pop",
    "stat": "count-up",
    "quote": "fade",
    "hook": "slide-up",
}

SUPPORTED_PRESETS = frozenset(_BASE.keys())


def is_motion_preset_supported(preset: str) -> bool:
    return preset in SUPPORTED_PRESETS


def default_preset_for_intent(intent: str) -> str:
    return _INTENT_DEFAULT_PRESET[intent]


def resolve_motion_preset_params(
    preset: str, layout_candidate: str | None
) -> MotionPresetParams:
    base = _BASE[preset]
    if layout_candidate is None:
        return base
    return MotionPresetParams(
        position_y=_CANDIDATE_POSITION_Y[layout_candidate],
        motion_preset=base.motion_preset,
        highlight_start=base.highlight_start,
        highlight_end=base.highlight_end,
    )
