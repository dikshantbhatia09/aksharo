from __future__ import annotations

import pytest

from aksharo_core_app.captions import (
    CaptionSegment,
    CaptionStyle,
    UnsupportedStyleError,
    build_captions,
    build_segment_item,
    ensure_caption_track,
    resync_captions,
)
from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.markers import find_mapping

STYLE_A = CaptionStyle(
    style_id="a", font="Arial", size=48.0, color=(1, 1, 1, 1), position=(0.5, 0.5)
)
STYLE_UNSUPPORTED = CaptionStyle(
    style_id="b",
    font="Arial",
    size=48.0,
    color=(1, 1, 1, 1),
    position=(0.5, 0.5),
    ass_renderable=False,
)


def make_timeline() -> TimelineHandle:
    return TimelineHandle(name="t", fps=25.0)


def test_build_captions_creates_one_clip_per_segment_and_stamps_marker() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segments = [
        CaptionSegment("seg1", 0, 1000, "hello", "a", rev=1),
        CaptionSegment("seg2", 1000, 2000, "world", "a", rev=1),
    ]
    items = build_captions(host, timeline, track, "proj1", segments, {"a": STYLE_A})

    assert len(items) == 2
    assert items[0].fusion_text is not None
    assert items[0].fusion_text.text == "hello"
    mapping = find_mapping(host, items[0])
    assert mapping is not None
    assert mapping.ref_id == "seg1"


def test_build_captions_falls_back_to_alpha_overlay_for_unsupported_style() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segments = [
        CaptionSegment(
            "seg1", 0, 1000, "hello", "b", rev=1, overlay_media_path="s3://render/seg1.mov"
        )
    ]
    items = build_captions(host, timeline, track, "proj1", segments, {"b": STYLE_UNSUPPORTED})

    assert items[0].fusion_text is None
    assert items[0].properties["sourcePath"] == "s3://render/seg1.mov"


def test_build_captions_raises_when_overlay_path_missing() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segments = [CaptionSegment("seg1", 0, 1000, "hello", "b", rev=1)]

    with pytest.raises(UnsupportedStyleError):
        build_captions(host, timeline, track, "proj1", segments, {"b": STYLE_UNSUPPORTED})


def test_resync_replaces_only_changed_segments() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segments = [
        CaptionSegment("seg1", 0, 1000, "hello", "a", rev=1),
        CaptionSegment("seg2", 1000, 2000, "world", "a", rev=1),
    ]
    first_items = build_captions(host, timeline, track, "proj1", segments, {"a": STYLE_A})

    updated_segments = [
        CaptionSegment("seg1", 0, 1000, "hello EDITED", "a", rev=2),  # changed
        CaptionSegment("seg2", 1000, 2000, "world", "a", rev=1),  # unchanged
    ]
    resync_captions(host, timeline, track, "proj1", updated_segments, {"a": STYLE_A})

    live = timeline.live_items()
    # seg1's old clip was deleted and replaced; seg2's original clip untouched.
    assert first_items[0].deleted is True
    assert first_items[1] in live
    seg1_live = [
        i for i in live if i.fusion_text is not None and i.fusion_text.text == "hello EDITED"
    ]
    assert len(seg1_live) == 1


def test_resync_creates_clip_for_brand_new_segment() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segments = [CaptionSegment("seg1", 0, 1000, "hello", "a", rev=1)]
    build_captions(host, timeline, track, "proj1", segments, {"a": STYLE_A})

    segments_with_new = [
        CaptionSegment("seg1", 0, 1000, "hello", "a", rev=1),
        CaptionSegment("seg2", 1000, 2000, "new segment", "a", rev=1),
    ]
    created = resync_captions(host, timeline, track, "proj1", segments_with_new, {"a": STYLE_A})
    assert len(created) == 1
    assert created[0].fusion_text is not None
    assert created[0].fusion_text.text == "new segment"


def test_build_segment_item_uses_macro_params_when_installed() -> None:
    """`fusion_macro_available()` finds the real, committed
    `AksharoCaption.setting` in this checkout, so the macro branch is live by
    default; `FakeResolveHost` records whatever params it's given even though
    it only interprets a subset of them."""
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segment = CaptionSegment(
        "seg1",
        0,
        1000,
        "hello",
        "a",
        rev=1,
        word_highlights=((0, 250), (250, 500)),
    )

    captured: dict[str, object] = {}
    original = host.append_text_plus

    def spy(timeline_, track_index, start_frame, end_frame, params):  # type: ignore[no-untyped-def]
        captured.update(params)
        return original(timeline_, track_index, start_frame, end_frame, params)

    host.append_text_plus = spy  # type: ignore[method-assign]
    build_segment_item(host, timeline, track, segment, STYLE_A)

    assert captured["fusion_macro"] == "AksharoCaption"
    assert captured["highlight_color"] == STYLE_A.color
    assert captured["highlight_keyframes"] == ((0, 6), (6, 12))  # 25 fps: 250ms=6.25->6 frames


def test_build_segment_item_omits_macro_params_when_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aksharo_core_app import captions as captions_module

    monkeypatch.setattr(captions_module, "fusion_macro_available", lambda: False)
    host = FakeResolveHost()
    timeline = make_timeline()
    track = ensure_caption_track(host, timeline)
    segment = CaptionSegment("seg1", 0, 1000, "hello", "a", rev=1)

    captured: dict[str, object] = {}
    original = host.append_text_plus

    def spy(timeline_, track_index, start_frame, end_frame, params):  # type: ignore[no-untyped-def]
        captured.update(params)
        return original(timeline_, track_index, start_frame, end_frame, params)

    host.append_text_plus = spy  # type: ignore[method-assign]
    build_segment_item(host, timeline, track, segment, STYLE_A)

    assert "fusion_macro" not in captured
    assert "highlight_color" not in captured
