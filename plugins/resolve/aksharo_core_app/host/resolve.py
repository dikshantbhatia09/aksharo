"""`ResolveHost`: the one seam between this package and the real Resolve API.

Every method here documents, in its own docstring, the exact
`DaVinciResolveScript` object/method it wraps (per the public Resolve
scripting README shipped in `<Resolve install>/Scripting/README.txt`, e.g.
`resolve.GetProjectManager()`, `Timeline.DeleteClips(items, ripple)`,
`TimelineItem.AddMarker(...)`). `RealResolveHost` is untested here (no Resolve
on this machine, and human spike A00-04 has not reported); `FakeResolveHost`
mirrors the same object model — ProjectManager -> Project -> MediaPool ->
Timeline -> TimelineItem, plus a Fusion comp for Text+ — so every other module
in this package is exercised against it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, cast

TrackType = Literal["video", "audio", "subtitle"]


@dataclass(slots=True)
class FusionTextPlus:
    """Stand-in for a `Comp:AddTool("TextPlus")` Fusion tool on a clip's comp."""

    text: str
    font: str
    size: float
    color: tuple[float, float, float, float]
    position: tuple[float, float]


@dataclass(slots=True)
class Marker:
    """Mirrors the dict `TimelineItem.GetMarkers()` returns, one entry per frame id."""

    color: str
    name: str
    note: str
    duration: int
    custom_data: str


@dataclass(slots=True)
class TimelineItemHandle:
    """Stand-in for a `TimelineItem` object."""

    item_id: str
    track_type: TrackType
    track_index: int
    start_frame: int
    end_frame: int
    name: str = ""
    properties: dict[str, object] = field(default_factory=dict)
    markers: dict[int, Marker] = field(default_factory=dict)
    fusion_text: FusionTextPlus | None = None
    deleted: bool = False


@dataclass(slots=True)
class TimelineHandle:
    """Stand-in for the current `Timeline` object."""

    name: str
    fps: float
    items: list[TimelineItemHandle] = field(default_factory=list)
    video_track_count: int = 1
    audio_track_count: int = 1

    def live_items(self) -> list[TimelineItemHandle]:
        return [item for item in self.items if not item.deleted]


class ResolveHost(Protocol):
    """Everything `captions.py`/`cuts.py`/`zooms.py`/`markers.py` need from Resolve."""

    def current_timeline(self) -> TimelineHandle | None:
        """`Project.GetCurrentTimeline()` (via `ProjectManager.GetCurrentProject()`)."""
        ...

    def add_track(self, timeline: TimelineHandle, track_type: TrackType, name: str) -> int:
        """`Timeline.AddTrack(trackType)` then name it via `Timeline.SetTrackName`."""
        ...

    def append_text_plus(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        params: dict[str, object],
    ) -> TimelineItemHandle:
        """`MediaPool.AppendToTimeline()` a generator clip, then
        `TimelineItem.AddFusionComp()` / `Comp:AddTool("TextPlus")` and set its
        inputs (`Comp:SetInput`) from `params` (a documented param table until
        C08b's macro lands; minimal set: text, font, size, colour, position)."""
        ...

    def import_alpha_overlay(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        """`MediaPool.ImportMedia([path])` then `MediaPool.AppendToTimeline()` for a
        style Text+ cannot render (A18a `assRenderable=false`): a PNG-sequence or
        ProRes 4444 alpha overlay rendered by the cloud renderer (A20)."""
        ...

    def delete_clips(self, timeline: TimelineHandle, items: list[TimelineItemHandle]) -> bool:
        """`Timeline.DeleteClips(timelineItems, ripple=True)` — accepted `cut` pass
        items ripple-delete the gap, matching `05-system-architecture.md` §6."""
        ...

    def set_property(self, item: TimelineItemHandle, key: str, value: object) -> bool:
        """`TimelineItem.SetProperty(propertyKey, propertyValue)`."""
        ...

    def add_marker(
        self,
        item: TimelineItemHandle,
        frame_id: int,
        color: str,
        name: str,
        note: str,
        duration: int,
        custom_data: str,
    ) -> bool:
        """`TimelineItem.AddMarker(frameId, color, name, note, duration, customData)`."""
        ...

    def get_markers(self, item: TimelineItemHandle) -> dict[int, Marker]:
        """`TimelineItem.GetMarkers()`."""
        ...

    def update_marker_custom_data(
        self, item: TimelineItemHandle, frame_id: int, custom_data: str
    ) -> bool:
        """`TimelineItem.UpdateMarkerCustomData(frameId, customData)`."""
        ...

    def delete_marker_by_custom_data(self, item: TimelineItemHandle, custom_data: str) -> bool:
        """`TimelineItem.DeleteMarkerByCustomData(customData)`."""
        ...

    def import_audio_clip(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        """`MediaPool.ImportMedia([path])` then `MediaPool.AppendToTimeline()` on an audio
        track (D09 brief §Scope 2: accepted sfx/music items as clips on dedicated audio
        tracks)."""
        ...

    def set_volume_keyframes(
        self, item: TimelineItemHandle, keyframes: list[tuple[int, float]]
    ) -> bool:
        """`TimelineItem.SetProperty("Volume", value)` per keyframe (D09 brief §Scope 2: "fades
        via clip properties, ducking as keyframed volume where the API allows (document
        limits)") — the public scripting README documents `SetProperty` as a single current-value
        setter, not a keyframe-track API; `RealResolveHost` below flags this as the open question
        for A00-04 (does Studio's per-clip volume actually accept a keyframed automation this
        way, or does this need the Fusion page's own keyframing instead)."""
        ...


class FakeResolveHost:
    """In-memory `ResolveHost` used by every test in this package."""

    def __init__(self, timeline: TimelineHandle | None = None) -> None:
        self._timeline = timeline
        self._next_id = 0

    def _fresh_id(self) -> str:
        self._next_id += 1
        return f"fake-item-{self._next_id}"

    def current_timeline(self) -> TimelineHandle | None:
        return self._timeline

    def set_timeline(self, timeline: TimelineHandle) -> None:
        self._timeline = timeline

    def add_track(self, timeline: TimelineHandle, track_type: TrackType, name: str) -> int:
        if track_type == "video":
            timeline.video_track_count += 1
            return timeline.video_track_count
        if track_type == "audio":
            timeline.audio_track_count += 1
            return timeline.audio_track_count
        raise NotImplementedError(f"FakeResolveHost does not model {track_type} tracks")

    def append_text_plus(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        params: dict[str, object],
    ) -> TimelineItemHandle:
        color = params.get("color", (1.0, 1.0, 1.0, 1.0))
        position = params.get("position", (0.5, 0.5))
        size = params.get("size", 48.0)
        item = TimelineItemHandle(
            item_id=self._fresh_id(),
            track_type="video",
            track_index=track_index,
            start_frame=start_frame,
            end_frame=end_frame,
            name=str(params.get("text", "")),
            fusion_text=FusionTextPlus(
                text=str(params.get("text", "")),
                font=str(params.get("font", "Arial")),
                size=float(size) if isinstance(size, int | float) else 48.0,
                color=cast("tuple[float, float, float, float]", color)
                if isinstance(color, tuple)
                else (1.0, 1.0, 1.0, 1.0),
                position=cast("tuple[float, float]", position)
                if isinstance(position, tuple)
                else (0.5, 0.5),
            ),
        )
        timeline.items.append(item)
        return item

    def import_alpha_overlay(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        item = TimelineItemHandle(
            item_id=self._fresh_id(),
            track_type="video",
            track_index=track_index,
            start_frame=start_frame,
            end_frame=end_frame,
            name=media_path,
            properties={"sourcePath": media_path, "overlay": True},
        )
        timeline.items.append(item)
        return item

    def delete_clips(self, timeline: TimelineHandle, items: list[TimelineItemHandle]) -> bool:
        ids = {item.item_id for item in items}
        for existing in timeline.items:
            if existing.item_id in ids:
                existing.deleted = True
        return True

    def set_property(self, item: TimelineItemHandle, key: str, value: object) -> bool:
        item.properties[key] = value
        return True

    def add_marker(
        self,
        item: TimelineItemHandle,
        frame_id: int,
        color: str,
        name: str,
        note: str,
        duration: int,
        custom_data: str,
    ) -> bool:
        if frame_id in item.markers:
            return False
        item.markers[frame_id] = Marker(
            color=color, name=name, note=note, duration=duration, custom_data=custom_data
        )
        return True

    def get_markers(self, item: TimelineItemHandle) -> dict[int, Marker]:
        return dict(item.markers)

    def update_marker_custom_data(
        self, item: TimelineItemHandle, frame_id: int, custom_data: str
    ) -> bool:
        marker = item.markers.get(frame_id)
        if marker is None:
            return False
        marker.custom_data = custom_data
        return True

    def delete_marker_by_custom_data(self, item: TimelineItemHandle, custom_data: str) -> bool:
        matches = [fid for fid, m in item.markers.items() if m.custom_data == custom_data]
        for fid in matches:
            del item.markers[fid]
        return len(matches) > 0

    def import_audio_clip(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        item = TimelineItemHandle(
            item_id=self._fresh_id(),
            track_type="audio",
            track_index=track_index,
            start_frame=start_frame,
            end_frame=end_frame,
            name=media_path,
            properties={"sourcePath": media_path},
        )
        timeline.items.append(item)
        return item

    def set_volume_keyframes(
        self, item: TimelineItemHandle, keyframes: list[tuple[int, float]]
    ) -> bool:
        item.properties["volumeKeyframes"] = list(keyframes)
        return True


class RealResolveHost:
    """Wraps the real `DaVinciResolveScript` module, imported lazily.

    Untestable on this host (no Resolve installed) and unverified against
    human spike A00-04 (Resolve scripting API coverage on Free vs Studio,
    `docs/PLAN.md`). Every method below documents the exact call it makes so
    that spike can be diffed against this file's assumptions.
    """

    def __init__(self) -> None:
        # `import DaVinciResolveScript; resolve = DaVinciResolveScript.scriptapp("Resolve")`
        # is the documented bootstrap for an *external* script; a Utility script
        # run from Workspace > Scripts instead receives a global `resolve`
        # object injected into its namespace (open question for A00-04 — does
        # Free grant this to a Utility script the same way Studio does).
        try:
            import DaVinciResolveScript
        except ImportError as exc:  # pragma: no cover - only reachable inside Resolve
            raise RuntimeError(
                "DaVinciResolveScript is only importable inside a running DaVinci "
                "Resolve process; RealResolveHost cannot be constructed here."
            ) from exc
        # documented: DaVinciResolveScript.scriptapp("Resolve")
        self._resolve = DaVinciResolveScript.scriptapp("Resolve")

    def _project(self) -> object:
        # `resolve.GetProjectManager().GetCurrentProject()`
        project_manager = self._resolve.GetProjectManager()
        return project_manager.GetCurrentProject()

    def current_timeline(self) -> TimelineHandle | None:
        raise NotImplementedError(
            "RealResolveHost.current_timeline: pending A00-04 confirmation of the "
            "Utility-script `resolve` global on Free; wraps "
            "Project.GetCurrentTimeline()."
        )

    def add_track(self, timeline: TimelineHandle, track_type: TrackType, name: str) -> int:
        raise NotImplementedError("wraps Timeline.AddTrack(trackType) + SetTrackName")

    def append_text_plus(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        params: dict[str, object],
    ) -> TimelineItemHandle:
        raise NotImplementedError(
            "wraps MediaPool.AppendToTimeline + TimelineItem.AddFusionComp + "
            'Comp:AddTool("TextPlus")'
        )

    def import_alpha_overlay(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        raise NotImplementedError("wraps MediaPool.ImportMedia + MediaPool.AppendToTimeline")

    def delete_clips(self, timeline: TimelineHandle, items: list[TimelineItemHandle]) -> bool:
        raise NotImplementedError("wraps Timeline.DeleteClips(items, ripple=True)")

    def set_property(self, item: TimelineItemHandle, key: str, value: object) -> bool:
        raise NotImplementedError("wraps TimelineItem.SetProperty(key, value)")

    def add_marker(
        self,
        item: TimelineItemHandle,
        frame_id: int,
        color: str,
        name: str,
        note: str,
        duration: int,
        custom_data: str,
    ) -> bool:
        raise NotImplementedError("wraps TimelineItem.AddMarker(...)")

    def get_markers(self, item: TimelineItemHandle) -> dict[int, Marker]:
        raise NotImplementedError("wraps TimelineItem.GetMarkers()")

    def update_marker_custom_data(
        self, item: TimelineItemHandle, frame_id: int, custom_data: str
    ) -> bool:
        raise NotImplementedError("wraps TimelineItem.UpdateMarkerCustomData(frameId, customData)")

    def delete_marker_by_custom_data(self, item: TimelineItemHandle, custom_data: str) -> bool:
        raise NotImplementedError("wraps TimelineItem.DeleteMarkerByCustomData(customData)")

    def import_audio_clip(
        self,
        timeline: TimelineHandle,
        track_index: int,
        start_frame: int,
        end_frame: int,
        media_path: str,
    ) -> TimelineItemHandle:
        raise NotImplementedError(
            "wraps MediaPool.ImportMedia([path]) + MediaPool.AppendToTimeline on an audio track "
            "(A00-04: confirm ImportMedia's own audio-track placement vs. needing "
            "MediaPool.AppendToTimeline's explicit trackIndex clipInfo)"
        )

    def set_volume_keyframes(
        self, item: TimelineItemHandle, keyframes: list[tuple[int, float]]
    ) -> bool:
        raise NotImplementedError(
            "wraps TimelineItem.SetProperty('Volume', value) per keyframe; A00-04 must confirm "
            "whether this actually keyframes or only sets one current value (see this method's "
            "Protocol docstring)"
        )
