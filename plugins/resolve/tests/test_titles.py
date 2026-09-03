from __future__ import annotations

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.markers import find_mapping
from aksharo_core_app.titles import LayoutHint, TitleItem, apply_titles, ensure_title_track

FPS = 25.0


def _timeline() -> TimelineHandle:
    return TimelineHandle(name="tl", fps=FPS)


def _title_item(**overrides: object) -> TitleItem:
    base: dict[str, object] = {
        "item_id": "title-1",
        "project_id": "proj-1",
        "start_ms": 500,
        "end_ms": 2500,
        "text": "Shipped in 3 days",
        "intent": "hook",
        "motion_preset": "slide-up",
        "style_id": "style-hook-1",
        "layout_hint": LayoutHint(candidate="upper-left"),
    }
    base.update(overrides)
    return TitleItem(**base)  # type: ignore[arg-type]


def test_apply_titles_places_a_text_plus_instance_with_resolved_params() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)
    track_index = ensure_title_track(host, timeline)

    result = apply_titles(host, timeline, track_index, [_title_item()], FPS)

    assert result.skipped == ()
    assert len(result.placed) == 1
    placed = result.placed[0]
    assert placed.item_id == "title-1"
    assert placed.via == "textplus"

    clip = next(i for i in timeline.items if i.item_id == placed.track_item_id)
    assert clip.fusion_text is not None
    assert clip.fusion_text.text == "Shipped in 3 days"

    mapping = find_mapping(host, clip)
    assert mapping is not None
    assert mapping.ref_id == "title-1"


def test_apply_titles_defaults_the_preset_from_intent_when_absent() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)
    track_index = ensure_title_track(host, timeline)

    item = _title_item(motion_preset=None, intent="quote", layout_hint=None)
    result = apply_titles(host, timeline, track_index, [item], FPS)

    assert len(result.placed) == 1
    assert result.placed[0].via == "textplus"


def test_apply_titles_places_multiple_items_independently() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)
    track_index = ensure_title_track(host, timeline)

    items = [
        _title_item(item_id="title-a"),
        _title_item(item_id="title-b", start_ms=3000, end_ms=4000),
    ]
    result = apply_titles(host, timeline, track_index, items, FPS)

    assert [p.item_id for p in result.placed] == ["title-a", "title-b"]


# The overlay-fallback branch is unreachable today (every D06 preset resolves via
# `motion_presets.py`'s table), matching `plugins/premiere-uxp/src/apply/titles.test.ts`'s same
# documented, honest state — not exercised here for the same reason.
