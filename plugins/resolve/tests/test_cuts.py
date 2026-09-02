from __future__ import annotations

from aksharo_core_app.cuts import CutItem, apply_cuts
from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.markers import HostMapping, stamp_item


def test_apply_cuts_deletes_mapped_clips() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25.0)
    item = host.append_text_plus(timeline, 1, 0, 100, {"text": "clip"})
    stamp_item(host, item, HostMapping("proj1", "itemId", "cut-1", rev=1))

    result = apply_cuts(host, timeline, "proj1", [CutItem("cut-1", "proj1", 0, 4000, rev=1)])

    assert item.deleted is True
    assert result.deleted == [item]
    assert "no explicit undo-transaction API" in result.warning


def test_apply_cuts_skips_items_with_no_mapped_clip() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25.0)

    result = apply_cuts(host, timeline, "proj1", [CutItem("cut-missing", "proj1", 0, 1000, rev=1)])

    assert result.deleted == []
