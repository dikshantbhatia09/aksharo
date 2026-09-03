"""TS/Python apply-plan parity (D09 brief §Scope 3).

Loads the exact same fixture `plugins/shared-apply/src/planBuilder.test.ts` builds and pins
against (`plugins/shared-apply/fixtures/sample-items.json` -> `sample-plan.json`) and asserts
this package's `apply_plan.parse_apply_plan` reads the golden plan into the same op count/fields
the TS side asserts — proving one EDG state produces a structurally equivalent plan on both
plugin runtimes without a duplicated Python port of `planBuilder.ts`'s own branching logic (see
`aksharo_core_app/apply_plan.py`'s module docstring for why).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from aksharo_core_app.apply_plan import AudioClipOp, DeleteRangeOp, TitleOp, parse_apply_plan

_SHARED_APPLY_FIXTURES = Path(__file__).resolve().parents[2] / "shared-apply" / "fixtures"


def _load_golden_plan() -> dict[str, Any]:
    with (_SHARED_APPLY_FIXTURES / "sample-plan.json").open(encoding="utf-8") as f:
        return cast("dict[str, Any]", json.load(f))


def test_golden_plan_fixture_exists_and_is_the_shared_apply_source() -> None:
    assert (_SHARED_APPLY_FIXTURES / "sample-items.json").is_file()
    assert (_SHARED_APPLY_FIXTURES / "sample-plan.json").is_file()


def test_parses_the_golden_plan_into_the_expected_op_shapes() -> None:
    plan = parse_apply_plan(_load_golden_plan())

    assert len(plan.ops) == 3
    delete_op, audio_op, title_op = plan.ops

    assert isinstance(delete_op, DeleteRangeOp)
    assert delete_op == DeleteRangeOp(item_id="cut-1", start_ms=1000, end_ms=1500)

    assert isinstance(audio_op, AudioClipOp)
    assert audio_op.item_id == "sfx-1"
    assert audio_op.kind == "sfx"
    assert audio_op.asset_id == "asset-whoosh-1"
    assert audio_op.gain_db == -4
    assert audio_op.fade_in_ms == 20
    assert audio_op.fade_out_ms == 40
    assert audio_op.duck is not None
    assert audio_op.duck.depth_db == -8
    assert audio_op.loop_policy is None
    assert audio_op.track_name == "Aksharo SFX"

    assert isinstance(title_op, TitleOp)
    assert title_op.item_id == "title-1"
    assert title_op.motion_preset == "slide-up"
    assert title_op.intent == "hook"
    assert title_op.layout_candidate == "upper-left"
    assert title_op.params["MotionPreset"] == "slide-up"
    assert title_op.params["PositionY"] == 20
    assert title_op.requires_overlay_fallback is False


def test_parses_the_golden_plan_audio_refusal() -> None:
    plan = parse_apply_plan(_load_golden_plan())
    assert len(plan.audio_refusals) == 1
    refusal = plan.audio_refusals[0]
    assert refusal.item_id == "music-1"
    assert refusal.kind == "music"
    assert refusal.reasons == ("not-owned", "surface-not-allowed")
