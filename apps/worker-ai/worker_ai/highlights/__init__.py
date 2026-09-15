"""Highlight discovery (Wave 4). REP-005 adds the contract; the processor follows.

Only the ``ai.highlights@1`` schema mirror lives here today. ``ai.highlights`` is a
registered queue with no processor, so it answers ``worker/not_implemented``, and
the ``highlight_discovery`` flag is seeded off.
"""

from __future__ import annotations

from worker_ai.highlights.contracts import (
    HIGHLIGHTS_SCHEMA_VERSION,
    MAX_DURATION_MS,
    MIN_DURATION_MS,
    HighlightProposal,
    HighlightsOptions,
    HighlightsPayload,
    HighlightsResult,
    ProposalReason,
    ScoreBreakdown,
    StorageObject,
    highlights_job_key,
)

__all__ = [
    "HIGHLIGHTS_SCHEMA_VERSION",
    "MAX_DURATION_MS",
    "MIN_DURATION_MS",
    "HighlightProposal",
    "HighlightsOptions",
    "HighlightsPayload",
    "HighlightsResult",
    "ProposalReason",
    "ScoreBreakdown",
    "StorageObject",
    "highlights_job_key",
]
