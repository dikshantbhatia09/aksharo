from __future__ import annotations

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.markers import (
    HostMapping,
    decode_custom_data,
    encode_custom_data,
    find_items_for_ref,
    find_mapping,
    needs_resync,
    stamp_item,
    unstamp_item,
)


def test_encode_decode_round_trip() -> None:
    mapping = HostMapping(project_id="proj1", ref_kind="segmentId", ref_id="seg1", rev=3)
    raw = encode_custom_data(mapping)
    assert decode_custom_data(raw) == mapping


def test_decode_rejects_garbage() -> None:
    assert decode_custom_data("not json") is None
    assert decode_custom_data("{}") is None
    assert decode_custom_data('{"aksharo": {"projectId": "p"}}') is None


def test_stamp_and_find_mapping_round_trip() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25)
    item = host.append_text_plus(timeline, 1, 0, 10, {"text": "hi"})
    mapping = HostMapping(project_id="proj1", ref_kind="segmentId", ref_id="seg1", rev=1)
    stamp_item(host, item, mapping)
    assert find_mapping(host, item) == mapping


def test_find_items_for_ref_filters_by_project_and_ref() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25)
    item_a = host.append_text_plus(timeline, 1, 0, 10, {"text": "a"})
    item_b = host.append_text_plus(timeline, 1, 10, 20, {"text": "b"})
    stamp_item(host, item_a, HostMapping("proj1", "segmentId", "seg1", 1))
    stamp_item(host, item_b, HostMapping("proj1", "segmentId", "seg2", 1))

    found = find_items_for_ref(host, timeline.live_items(), "proj1", "seg1")
    assert found == [item_a]
    assert find_items_for_ref(host, timeline.live_items(), "proj1", "seg-missing") == []


def test_unstamp_item_removes_marker() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25)
    item = host.append_text_plus(timeline, 1, 0, 10, {"text": "a"})
    mapping = HostMapping("proj1", "segmentId", "seg1", 1)
    stamp_item(host, item, mapping)
    assert unstamp_item(host, item, mapping) is True
    assert find_mapping(host, item) is None


def test_needs_resync() -> None:
    mapping = HostMapping("proj1", "segmentId", "seg1", 3)
    assert needs_resync(mapping, 4) is True
    assert needs_resync(mapping, 3) is False
    assert needs_resync(mapping, 2) is False
