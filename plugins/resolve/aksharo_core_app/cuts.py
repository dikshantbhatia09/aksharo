"""Apply accepted B20 `cut` pass items to a Resolve timeline.

`05-system-architecture.md` §6: cuts are applied with
`Timeline.DeleteClips(items, True)` (ripple). An "apply transaction" is
documented as an undo-able group via Resolve's timeline versioning; the
scripting API exposes no explicit transaction/undo-group call, so this module
documents that limitation rather than inventing one (see `ApplyResult.warning`).
"""

from __future__ import annotations

from dataclasses import dataclass

from aksharo_core_app.host.resolve import ResolveHost, TimelineHandle, TimelineItemHandle
from aksharo_core_app.markers import find_items_for_ref

NO_UNDO_GROUP_WARNING = (
    "DaVinciResolveScript exposes no explicit undo-transaction API; each deleted "
    "clip is an individually undoable Resolve action (Ctrl/Cmd+Z per clip), not "
    "one grouped undo. Confirm during A00-04 whether Studio's timeline "
    "versioning can be scripted to group these."
)


@dataclass(frozen=True, slots=True)
class CutItem:
    item_id: str
    project_id: str
    start_ms: float
    end_ms: float
    rev: int


@dataclass(frozen=True, slots=True)
class ApplyCutsResult:
    deleted: list[TimelineItemHandle]
    warning: str = NO_UNDO_GROUP_WARNING


def apply_cuts(
    host: ResolveHost, timeline: TimelineHandle, project_id: str, items: list[CutItem]
) -> ApplyCutsResult:
    """Delete (ripple) the timeline clips mapped to each accepted cut item.

    Items with no existing mapped clip are skipped (nothing to delete yet —
    the caption/clip build step for that range has not run); this only ever
    removes clips already stamped with this item's host mapping.
    """
    to_delete: list[TimelineItemHandle] = []
    for cut in items:
        matches = find_items_for_ref(host, timeline.live_items(), project_id, cut.item_id)
        to_delete.extend(matches)
    if to_delete:
        host.delete_clips(timeline, to_delete)
    return ApplyCutsResult(deleted=to_delete)
