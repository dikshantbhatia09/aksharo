"""Client-side licence re-check for sfx/music items (D09 brief §Scope 2, D43 "cloud render
only"). Python port of `plugins/shared-apply/src/licence.ts` — a small, static gate (not the
plan-building logic itself, see `apply_plan.py`'s module docstring for why *that* is not
ported), so duplicating it in both languages carries none of the drift risk a full plan-builder
port would.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PANEL_SURFACE = "panel"

DenyReason = Literal["not-owned", "surface-not-allowed"]

CLOUD_RENDER_ONLY_MESSAGE = (
    "This track is a partner-catalogue asset and can only be used in a cloud render, not "
    "placed directly on the timeline. Accept it as-is and export via cloud render, or swap it "
    "for an owned-library asset."
)


@dataclass(frozen=True, slots=True)
class LicenceSnapshot:
    allows_raw_file_delivery: bool
    surface: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LicenceCheckResult:
    allowed: bool
    reasons: tuple[DenyReason, ...]


def check_licence_for_panel(snapshot: LicenceSnapshot) -> LicenceCheckResult:
    reasons: list[DenyReason] = []
    if not snapshot.allows_raw_file_delivery:
        reasons.append("not-owned")
    if PANEL_SURFACE not in snapshot.surface:
        reasons.append("surface-not-allowed")
    return LicenceCheckResult(allowed=len(reasons) == 0, reasons=tuple(reasons))
