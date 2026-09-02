from __future__ import annotations

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle


def make_timeline(fps: float = 25.0) -> TimelineHandle:
    return TimelineHandle(name="Timeline 1", fps=fps)


def test_append_text_plus_creates_item_with_fusion_text() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    item = host.append_text_plus(
        timeline, 2, 0, 100, {"text": "hello", "font": "Arial", "size": 48.0}
    )
    assert item in timeline.items
    assert item.fusion_text is not None
    assert item.fusion_text.text == "hello"


def test_delete_clips_marks_items_deleted_and_hides_from_live_items() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    item = host.append_text_plus(timeline, 1, 0, 10, {"text": "x"})
    assert item in timeline.live_items()
    host.delete_clips(timeline, [item])
    assert item.deleted is True
    assert item not in timeline.live_items()


def test_add_marker_then_update_and_delete_by_custom_data() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    item = host.append_text_plus(timeline, 1, 0, 10, {"text": "x"})

    assert host.add_marker(item, 0, "Cyan", "Aksharo", "note", 1, '{"a":1}') is True
    # Adding at the same frame again is a no-op (mirrors AddMarker returning False).
    assert host.add_marker(item, 0, "Cyan", "Aksharo", "note", 1, '{"a":2}') is False

    assert host.update_marker_custom_data(item, 0, '{"a":2}') is True
    assert host.get_markers(item)[0].custom_data == '{"a":2}'

    assert host.delete_marker_by_custom_data(item, '{"a":2}') is True
    assert 0 not in host.get_markers(item)
    assert host.delete_marker_by_custom_data(item, '{"a":2}') is False


def test_add_track_increments_track_counts() -> None:
    host = FakeResolveHost()
    timeline = make_timeline()
    assert host.add_track(timeline, "video", "Aksharo Captions") == 2
    assert timeline.video_track_count == 2
