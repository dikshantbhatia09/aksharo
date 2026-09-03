"""Python mirror of `@montaj/shared-apply`'s `ApplyOp`/`ApplyPlan` shapes (D09 brief §Scope 3).

This is deliberately **shapes only**, not a second implementation of `planBuilder.ts`'s
branching logic (the licence gate, the motion-preset resolution, which item kinds produce an
op): that logic lives once, in TS, and this module's job is only to read the JSON a plan built
by that logic produces — either the fixture both `plugins/shared-apply`'s
`planBuilder.test.ts` and this package's `tests/test_apply_plan_parity.py` load
(`plugins/shared-apply/fixtures/sample-plan.json`), or a plan handed to this plugin over the
bridge/API once D09's producer side exists. Porting the *building* logic to Python as well would
mean two independently-maintained copies of the licence gate and preset table — the actual drift
risk the brief's "pick one and justify" question is about — so this module only parses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast

OpKind = Literal["deleteRange", "motionKeyframes", "audioClip", "title"]


@dataclass(frozen=True, slots=True)
class DeleteRangeOp:
    item_id: str
    start_ms: float
    end_ms: float


@dataclass(frozen=True, slots=True)
class DecodedKeyframe:
    t_ms: float
    zoom: float
    cx: float
    cy: float
    ease: Literal["linear", "inOut"]


@dataclass(frozen=True, slots=True)
class MotionKeyframesOp:
    item_id: str
    keyframes: tuple[DecodedKeyframe, ...]


@dataclass(frozen=True, slots=True)
class DuckSpec:
    depth_db: float
    attack_ms: float
    release_ms: float


@dataclass(frozen=True, slots=True)
class AudioClipOp:
    item_id: str
    kind: Literal["sfx", "music"]
    asset_id: str
    pack_id: str
    start_ms: float
    duration_ms: float
    gain_db: float
    fade_in_ms: float
    fade_out_ms: float
    duck: DuckSpec | None
    loop_policy: Literal["none", "loop", "trim"] | None
    track_name: str


@dataclass(frozen=True, slots=True)
class TitleOp:
    item_id: str
    start_ms: float
    end_ms: float
    text: str
    motion_preset: str
    intent: str
    layout_candidate: str
    params: dict[str, str | float]
    requires_overlay_fallback: bool


ApplyOp = DeleteRangeOp | MotionKeyframesOp | AudioClipOp | TitleOp


@dataclass(frozen=True, slots=True)
class AudioClipRefusal:
    item_id: str
    kind: Literal["sfx", "music"]
    asset_id: str
    reasons: tuple[str, ...]
    message: str


@dataclass(frozen=True, slots=True)
class ApplyPlan:
    ops: tuple[ApplyOp, ...]
    audio_refusals: tuple[AudioClipRefusal, ...]


class ApplyPlanParseError(Exception):
    """Raised when a plan JSON document uses an op shape this module doesn't recognise."""


def _parse_keyframe(raw: dict[str, Any]) -> DecodedKeyframe:
    return DecodedKeyframe(
        t_ms=raw["tMs"], zoom=raw["zoom"], cx=raw["cx"], cy=raw["cy"], ease=raw["ease"]
    )


def _parse_duck(raw: dict[str, Any] | None) -> DuckSpec | None:
    if raw is None:
        return None
    return DuckSpec(depth_db=raw["depthDb"], attack_ms=raw["attackMs"], release_ms=raw["releaseMs"])


def _parse_op(raw: dict[str, Any]) -> ApplyOp:
    op = raw.get("op")
    if op == "deleteRange":
        return DeleteRangeOp(item_id=raw["itemId"], start_ms=raw["startMs"], end_ms=raw["endMs"])
    if op == "motionKeyframes":
        return MotionKeyframesOp(
            item_id=raw["itemId"],
            keyframes=tuple(_parse_keyframe(k) for k in raw["keyframes"]),
        )
    if op == "audioClip":
        fade = raw["fade"]
        return AudioClipOp(
            item_id=raw["itemId"],
            kind=raw["kind"],
            asset_id=raw["assetId"],
            pack_id=raw["packId"],
            start_ms=raw["startMs"],
            duration_ms=raw["durationMs"],
            gain_db=raw["gainDb"],
            fade_in_ms=fade["fadeInMs"],
            fade_out_ms=fade["fadeOutMs"],
            duck=_parse_duck(raw["duck"]),
            loop_policy=raw["loopPolicy"],
            track_name=raw["trackName"],
        )
    if op == "title":
        return TitleOp(
            item_id=raw["itemId"],
            start_ms=raw["startMs"],
            end_ms=raw["endMs"],
            text=raw["text"],
            motion_preset=raw["motionPreset"],
            intent=raw["intent"],
            layout_candidate=raw["layoutCandidate"],
            params=dict(raw["params"]),
            requires_overlay_fallback=raw["requiresOverlayFallback"],
        )
    raise ApplyPlanParseError(f"unknown op kind {op!r}")


def _parse_refusal(raw: dict[str, Any]) -> AudioClipRefusal:
    return AudioClipRefusal(
        item_id=raw["itemId"],
        kind=raw["kind"],
        asset_id=raw["assetId"],
        reasons=tuple(raw["reasons"]),
        message=raw["message"],
    )


def parse_apply_plan(data: dict[str, Any]) -> ApplyPlan:
    """Parses one JSON `ApplyPlan` document (the shape `@montaj/shared-apply`'s `buildApplyPlan`
    produces) into this module's dataclasses."""
    ops = tuple(_parse_op(cast("dict[str, Any]", raw)) for raw in data["ops"])
    refusals = tuple(_parse_refusal(cast("dict[str, Any]", raw)) for raw in data["audioRefusals"])
    return ApplyPlan(ops=ops, audio_refusals=refusals)
