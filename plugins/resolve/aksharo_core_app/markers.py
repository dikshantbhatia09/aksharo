"""Marker `customData` host-mapping: `{aksharo: {projectId, segmentId|itemId, rev}}`.

Every Text+/cut/zoom item this package creates gets a marker at its start frame
carrying this JSON blob (05-system-architecture.md §6: "host mappings in
marker customData"), so a later `re-sync` can find and update or remove it
without keeping any state outside the Resolve project itself.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from aksharo_core_app.host.resolve import ResolveHost, TimelineItemHandle

MARKER_COLOR = "Cyan"
MARKER_NAME = "Aksharo"
_MARKER_FRAME = 0  # relative to the item's own start; markers are per-item-local


@dataclass(frozen=True, slots=True)
class HostMapping:
    project_id: str
    ref_kind: Literal["segmentId", "itemId"]
    ref_id: str
    rev: int


def encode_custom_data(mapping: HostMapping) -> str:
    return json.dumps(
        {
            "aksharo": {
                "projectId": mapping.project_id,
                mapping.ref_kind: mapping.ref_id,
                "rev": mapping.rev,
            }
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def decode_custom_data(raw: str) -> HostMapping | None:
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    aksharo = payload.get("aksharo") if isinstance(payload, dict) else None
    if not isinstance(aksharo, dict):
        return None
    project_id = aksharo.get("projectId")
    rev = aksharo.get("rev")
    if not isinstance(project_id, str) or not isinstance(rev, int):
        return None
    for ref_kind in ("segmentId", "itemId"):
        ref_id = aksharo.get(ref_kind)
        if isinstance(ref_id, str):
            return HostMapping(project_id=project_id, ref_kind=ref_kind, ref_id=ref_id, rev=rev)
    return None


def stamp_item(host: ResolveHost, item: TimelineItemHandle, mapping: HostMapping) -> None:
    """Add (or replace) the host-mapping marker on a freshly created item."""
    custom_data = encode_custom_data(mapping)
    added = host.add_marker(
        item,
        _MARKER_FRAME,
        MARKER_COLOR,
        MARKER_NAME,
        note="Managed by Aksharo — do not edit this marker.",
        duration=1,
        custom_data=custom_data,
    )
    if not added:
        host.update_marker_custom_data(item, _MARKER_FRAME, custom_data)


def find_mapping(host: ResolveHost, item: TimelineItemHandle) -> HostMapping | None:
    markers = host.get_markers(item)
    marker = markers.get(_MARKER_FRAME)
    if marker is None:
        return None
    return decode_custom_data(marker.custom_data)


def find_items_for_ref(
    host: ResolveHost,
    items: list[TimelineItemHandle],
    project_id: str,
    ref_id: str,
) -> list[TimelineItemHandle]:
    """All live items whose marker mapping points at `ref_id` in `project_id`."""
    found = []
    for item in items:
        mapping = find_mapping(host, item)
        if mapping is not None and mapping.project_id == project_id and mapping.ref_id == ref_id:
            found.append(item)
    return found


def unstamp_item(host: ResolveHost, item: TimelineItemHandle, mapping: HostMapping) -> bool:
    return host.delete_marker_by_custom_data(item, encode_custom_data(mapping))


def needs_resync(existing: HostMapping, incoming_rev: int) -> bool:
    """True when a segment/item changed since the marker was last stamped."""
    return incoming_rev > existing.rev
