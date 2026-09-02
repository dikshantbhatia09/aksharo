"""Text+ caption builder: one clip per EDG transcript segment.

Consumes the `transcript.push` payload / `GET /projects/{id}/transcript`
response (already resolved to plain segments by the caller) and a style
lookup keyed by `Segment.styleRef` (CONTRACTS §2). A style Text+ cannot render
(A18a's `assRenderable=false`) falls back to importing a pre-rendered alpha
overlay (PNG sequence / ProRes 4444 from the cloud renderer, A20) instead of
raising.

Until C08b's Fusion Text+ macro parameter table lands, `CaptionStyle` carries
only the minimal param set the brief calls out: text, font, size, colour,
position.
"""

from __future__ import annotations

from dataclasses import dataclass

from aksharo_core_app.fusion.macro import MACRO_TOOL_NAME, fusion_macro_available
from aksharo_core_app.host.resolve import ResolveHost, TimelineHandle, TimelineItemHandle
from aksharo_core_app.markers import (
    HostMapping,
    find_items_for_ref,
    find_mapping,
    needs_resync,
    stamp_item,
)

CAPTION_TRACK_NAME = "Aksharo Captions"


@dataclass(frozen=True, slots=True)
class CaptionStyle:
    style_id: str
    font: str
    size: float
    color: tuple[float, float, float, float]
    position: tuple[float, float]
    # Mirrors A18a's `assRenderable` flag: false means Text+ cannot express this
    # style faithfully (e.g. a per-character gradient/animation preset) and the
    # caption must come in as a pre-rendered alpha overlay instead.
    ass_renderable: bool = True
    # C08b: the macro's `HighlightColour` input. Defaults to `color` (no visible
    # change) when a style doesn't define a distinct highlight/accent colour.
    highlight_color: tuple[float, float, float, float] | None = None


@dataclass(frozen=True, slots=True)
class CaptionSegment:
    segment_id: str
    start_ms: float
    end_ms: float
    text: str
    style_ref: str
    rev: int
    # Required only when the resolved style has `ass_renderable=False`.
    overlay_media_path: str | None = None
    # C08b: per-word (start_ms, end_ms) spans, in segment-relative time, driving
    # the macro's `HighlightStart`/`HighlightEnd` keyframes. `None` means "no
    # per-word timing available"; the macro branch then leaves the whole
    # segment highlighted (no keyframes) rather than guessing word boundaries.
    word_highlights: tuple[tuple[float, float], ...] | None = None


class UnsupportedStyleError(Exception):
    """A segment needs an alpha overlay but no rendered media path was given."""


def ms_to_frame(ms: float, fps: float) -> int:
    return round(ms / 1000.0 * fps)


def ensure_caption_track(host: ResolveHost, timeline: TimelineHandle) -> int:
    """Adds a dedicated video track for captions and returns its index."""
    return host.add_track(timeline, "video", CAPTION_TRACK_NAME)


def build_segment_item(
    host: ResolveHost,
    timeline: TimelineHandle,
    track_index: int,
    segment: CaptionSegment,
    style: CaptionStyle,
) -> TimelineItemHandle:
    start_frame = ms_to_frame(segment.start_ms, timeline.fps)
    end_frame = ms_to_frame(segment.end_ms, timeline.fps)
    if style.ass_renderable:
        params: dict[str, object] = {
            "text": segment.text,
            "font": style.font,
            "size": style.size,
            "color": style.color,
            "position": style.position,
        }
        # C08b: when `AksharoCaption.setting` is installed, use it instead of a
        # bare Text+ so per-word highlight timing is expressed as the macro's
        # published `HighlightStart`/`HighlightEnd` keyframes; when it is not
        # installed (dev/CI, or an older Resolve install C10 hasn't reached
        # yet), fall through to the minimal param set above unchanged.
        if fusion_macro_available():
            params["fusion_macro"] = MACRO_TOOL_NAME
            params["highlight_color"] = style.highlight_color or style.color
            if segment.word_highlights is not None:
                params["highlight_keyframes"] = tuple(
                    (
                        ms_to_frame(start_ms, timeline.fps) - start_frame,
                        ms_to_frame(end_ms, timeline.fps) - start_frame,
                    )
                    for start_ms, end_ms in segment.word_highlights
                )
        return host.append_text_plus(timeline, track_index, start_frame, end_frame, params)
    if segment.overlay_media_path is None:
        raise UnsupportedStyleError(
            f"style {style.style_id!r} is not Text+-renderable and segment "
            f"{segment.segment_id!r} carries no rendered overlay media path"
        )
    return host.import_alpha_overlay(
        timeline, track_index, start_frame, end_frame, segment.overlay_media_path
    )


def build_captions(
    host: ResolveHost,
    timeline: TimelineHandle,
    track_index: int,
    project_id: str,
    segments: list[CaptionSegment],
    styles: dict[str, CaptionStyle],
) -> list[TimelineItemHandle]:
    """Build one clip per segment and stamp each with its host mapping."""
    created: list[TimelineItemHandle] = []
    for segment in segments:
        style = styles[segment.style_ref]
        item = build_segment_item(host, timeline, track_index, segment, style)
        stamp_item(
            host,
            item,
            HostMapping(
                project_id=project_id,
                ref_kind="segmentId",
                ref_id=segment.segment_id,
                rev=segment.rev,
            ),
        )
        created.append(item)
    return created


def resync_captions(
    host: ResolveHost,
    timeline: TimelineHandle,
    track_index: int,
    project_id: str,
    segments: list[CaptionSegment],
    styles: dict[str, CaptionStyle],
) -> list[TimelineItemHandle]:
    """`re-sync`: replace only the segments whose `rev` moved on since they were
    stamped; segments with no existing item are created; unchanged ones are
    left alone."""
    created: list[TimelineItemHandle] = []
    for segment in segments:
        existing_items = find_items_for_ref(
            host, timeline.live_items(), project_id, segment.segment_id
        )
        if existing_items:
            mapping = find_mapping(host, existing_items[0])
            if mapping is not None and not needs_resync(mapping, segment.rev):
                continue  # unchanged: leave the existing clip alone
            host.delete_clips(timeline, existing_items)
        style = styles[segment.style_ref]
        item = build_segment_item(host, timeline, track_index, segment, style)
        stamp_item(
            host,
            item,
            HostMapping(
                project_id=project_id,
                ref_kind="segmentId",
                ref_id=segment.segment_id,
                rev=segment.rev,
            ),
        )
        created.append(item)
    return created
