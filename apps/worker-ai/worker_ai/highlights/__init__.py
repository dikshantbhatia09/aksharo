"""Highlight discovery (Wave 4): the ``ai.highlights@1`` contract and its parts.

- ``contracts`` - the schema mirror of ``packages/repurpose-contracts``;
- ``windows`` - sentence units and candidate windows over the whole transcript,
  and the spread-aware choice between them;
- ``scoring`` - the content signals a window is scored on;
- ``text`` - sentence ends in Latin and Devanagari, titles and excerpts.

The processor that puts them together is ``worker_ai.processors.highlights``.
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
