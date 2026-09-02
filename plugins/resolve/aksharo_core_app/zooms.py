"""Apply accepted B20 `zoom` pass items to a Resolve timeline.

`05-system-architecture.md` §6: zooms are applied with `DynamicZoomEase` +
start/end rects. Resolve's Dynamic Zoom (Cut/Edit page inspector) is a
two-point ease between a start and an end rectangle, not an arbitrary curve —
so a B19 `Keyframe` curve (which may carry many points via MKF2) is
approximated to its two extremes: the first and last keyframe by `t_ms`. This
loses any intermediate curve shape; it is the documented approximation the
brief calls for, not a full port of the curve.
"""

from __future__ import annotations

from dataclasses import dataclass

from aksharo_core_app.host.resolve import ResolveHost, TimelineHandle, TimelineItemHandle
from aksharo_core_app.keyframes import Keyframe, decode_keyframes
from aksharo_core_app.markers import HostMapping, stamp_item

DYNAMIC_ZOOM_APPROXIMATION_NOTE = (
    "Resolve's DynamicZoomEase is start/end only; intermediate MKF2 keyframes "
    "between the first and last are not represented on the timeline."
)


@dataclass(frozen=True, slots=True)
class ZoomRect:
    """A `DynamicZoomEase` endpoint: crop centre + zoom factor."""

    zoom: float
    cx: float
    cy: float


@dataclass(frozen=True, slots=True)
class ZoomEndpoints:
    start: ZoomRect
    end: ZoomRect
    ease: str


@dataclass(frozen=True, slots=True)
class ZoomItem:
    item_id: str
    project_id: str
    start_ms: float
    end_ms: float
    rev: int
    keyframes: bytes  # raw MKF2 bytes decoded from payload.keyframes/keyframesRef


def keyframe_extremes(frames: list[Keyframe]) -> ZoomEndpoints:
    """Pick the start/end rects Resolve's two-point Dynamic Zoom can express."""
    if not frames:
        raise ValueError("a zoom item must carry at least one keyframe")
    ordered = sorted(frames, key=lambda f: f.t_ms)
    first, last = ordered[0], ordered[-1]
    return ZoomEndpoints(
        start=ZoomRect(zoom=first.zoom, cx=first.cx, cy=first.cy),
        end=ZoomRect(zoom=last.zoom, cx=last.cx, cy=last.cy),
        ease=last.ease,
    )


def apply_zoom(
    host: ResolveHost,
    timeline: TimelineHandle,
    item: TimelineItemHandle,
    zoom: ZoomItem,
) -> ZoomEndpoints:
    """Decode `zoom.keyframes` and set start/end Dynamic Zoom properties on `item`."""
    frames = decode_keyframes(zoom.keyframes)
    endpoints = keyframe_extremes(frames)
    # Property keys per `TimelineItem.SetProperty` (documented common keys:
    # "ZoomX"/"ZoomY"/"Pan"/"Tilt"); Resolve keyframes these when Dynamic Zoom is
    # enabled on the clip rather than through a dedicated `DynamicZoomEase` call
    # name — there is no such literal API method, only the inspector feature the
    # architecture doc names that way. This is the open question for A00-04.
    host.set_property(item, "ZoomGang", True)
    host.set_property(item, "Zoom_Start", endpoints.start.zoom)
    host.set_property(item, "Pan_Start", endpoints.start.cx)
    host.set_property(item, "Tilt_Start", endpoints.start.cy)
    host.set_property(item, "Zoom_End", endpoints.end.zoom)
    host.set_property(item, "Pan_End", endpoints.end.cx)
    host.set_property(item, "Tilt_End", endpoints.end.cy)
    host.set_property(item, "Ease", endpoints.ease)
    stamp_item(
        host,
        item,
        HostMapping(
            project_id=zoom.project_id, ref_kind="itemId", ref_id=zoom.item_id, rev=zoom.rev
        ),
    )
    return endpoints
