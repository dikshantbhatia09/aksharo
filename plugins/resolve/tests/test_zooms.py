from __future__ import annotations

import pytest

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.keyframes import Keyframe, encode_keyframes
from aksharo_core_app.markers import find_mapping
from aksharo_core_app.zooms import ZoomItem, apply_zoom, keyframe_extremes


def test_keyframe_extremes_picks_first_and_last_by_time() -> None:
    frames = [
        Keyframe(t_ms=780, zoom=1.2, cx=0.5, cy=0.5, ease="inOut"),
        Keyframe(t_ms=0, zoom=1.0, cx=0.4, cy=0.4, ease="linear"),
        Keyframe(t_ms=400, zoom=1.5, cx=0.6, cy=0.6, ease="linear"),  # dropped: middle point
    ]
    endpoints = keyframe_extremes(frames)
    assert endpoints.start.zoom == 1.0
    assert endpoints.end.zoom == 1.2
    assert endpoints.ease == "inOut"


def test_keyframe_extremes_rejects_empty_curve() -> None:
    with pytest.raises(ValueError, match="at least one keyframe"):
        keyframe_extremes([])


def test_apply_zoom_sets_properties_and_stamps_marker() -> None:
    host = FakeResolveHost()
    timeline = TimelineHandle(name="t", fps=25.0)
    item = host.append_text_plus(timeline, 1, 0, 100, {"text": "clip"})
    keyframes = encode_keyframes(
        [
            Keyframe(t_ms=0, zoom=1.0, cx=0.5, cy=0.5, ease="linear"),
            Keyframe(t_ms=780, zoom=1.2, cx=0.5, cy=0.5, ease="inOut"),
        ]
    )
    zoom = ZoomItem("zoom-1", "proj1", start_ms=0, end_ms=780, rev=1, keyframes=keyframes)

    endpoints = apply_zoom(host, timeline, item, zoom)

    assert endpoints.start.zoom == 1.0
    assert endpoints.end.zoom == pytest.approx(1.2, rel=1e-4)
    assert item.properties["Zoom_Start"] == 1.0
    assert item.properties["Zoom_End"] == pytest.approx(1.2, rel=1e-4)
    assert item.properties["Ease"] == "inOut"

    mapping = find_mapping(host, item)
    assert mapping is not None
    assert mapping.ref_id == "zoom-1"
