"""Apply accepted `title` pass items to a Resolve timeline as Text+ macro instances (D09 brief
§Scope 2). CONTRACTS §2 amendment: there is no `text_fx` `ItemKind` — text-fx items ride `title`
with `intent`/`motionPreset`/`anchorWordIds`/`layoutHint`; this module maps `motionPreset` to the
`AksharoCaption` macro's published inputs (`fusion/macro.py`) via `motion_presets.py`'s static
table (same mapping `plugins/premiere-uxp`'s title MOGRT applies, ported per that module's
docstring).

Unlike `captions.py` (one clip per transcript segment, always Text+/overlay), a title has no
"segment" — it is a standalone graphic over the given range, so this module builds its own
`TimelineItemHandle` via `ResolveHost.append_text_plus` directly rather than routing through
`captions.py`'s segment-shaped builder.
"""

from __future__ import annotations

from dataclasses import dataclass

from aksharo_core_app.host.resolve import ResolveHost, TimelineHandle
from aksharo_core_app.markers import HostMapping, stamp_item
from aksharo_core_app.motion_presets import (
    default_preset_for_intent,
    is_motion_preset_supported,
    resolve_motion_preset_params,
)

TITLE_TRACK_NAME = "Aksharo Titles"


@dataclass(frozen=True, slots=True)
class LayoutHint:
    candidate: str


@dataclass(frozen=True, slots=True)
class TitleItem:
    item_id: str
    project_id: str
    start_ms: float
    end_ms: float
    text: str
    intent: str = "title"
    motion_preset: str | None = None
    style_id: str = ""
    layout_hint: LayoutHint | None = None
    rev: int = 0


@dataclass(frozen=True, slots=True)
class PlacedTitle:
    item_id: str
    track_item_id: str
    via: str  # "textplus" | "overlay"


@dataclass(frozen=True, slots=True)
class SkippedTitle:
    item_id: str
    reason: str


@dataclass(frozen=True, slots=True)
class ApplyTitlesResult:
    placed: tuple[PlacedTitle, ...]
    skipped: tuple[SkippedTitle, ...]


def ms_to_frame(ms: float, fps: float) -> int:
    return round(ms / 1000.0 * fps)


def ensure_title_track(host: ResolveHost, timeline: TimelineHandle) -> int:
    return host.add_track(timeline, "video", TITLE_TRACK_NAME)


def apply_titles(
    host: ResolveHost,
    timeline: TimelineHandle,
    track_index: int,
    items: list[TitleItem],
    fps: float,
    overlay_media_paths: dict[str, str] | None = None,
) -> ApplyTitlesResult:
    placed: list[PlacedTitle] = []
    skipped: list[SkippedTitle] = []
    overlay_media_paths = overlay_media_paths or {}

    for item in items:
        preset = item.motion_preset or default_preset_for_intent(item.intent)
        start_frame = ms_to_frame(item.start_ms, fps)
        end_frame = ms_to_frame(item.end_ms, fps)

        if not is_motion_preset_supported(preset):
            overlay_path = overlay_media_paths.get(item.item_id)
            if overlay_path is None:
                skipped.append(
                    SkippedTitle(item_id=item.item_id, reason="overlay-media-not-rendered")
                )
                continue
            clip = host.import_alpha_overlay(
                timeline, track_index, start_frame, end_frame, overlay_path
            )
            mapping = HostMapping(
                project_id=item.project_id, ref_kind="itemId", ref_id=item.item_id, rev=item.rev
            )
            stamp_item(host, clip, mapping)
            placed.append(
                PlacedTitle(item_id=item.item_id, track_item_id=clip.item_id, via="overlay")
            )
            continue

        params = resolve_motion_preset_params(
            preset, item.layout_hint.candidate if item.layout_hint is not None else None
        )
        clip = host.append_text_plus(
            timeline,
            track_index,
            start_frame,
            end_frame,
            {
                "text": item.text,
                "fusion_macro": "AksharoCaption",
                "motion_preset": params.motion_preset,
                "position": (0.5, params.position_y / 100.0),
                "highlight_start": params.highlight_start,
                "highlight_end": params.highlight_end,
                "style_id": item.style_id,
            },
        )
        mapping = HostMapping(
            project_id=item.project_id, ref_kind="itemId", ref_id=item.item_id, rev=item.rev
        )
        stamp_item(host, clip, mapping)
        placed.append(
            PlacedTitle(item_id=item.item_id, track_item_id=clip.item_id, via="textplus")
        )

    return ApplyTitlesResult(placed=tuple(placed), skipped=tuple(skipped))
