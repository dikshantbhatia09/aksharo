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
    DiagnosticItem,
    HighlightProposal,
    HighlightsOptions,
    HighlightsPayload,
    HighlightsResult,
    NativeChapter,
    ProposalReason,
    ScoreBreakdown,
    StorageObject,
    ViralityDiagnostic,
    highlights_job_key,
)
from worker_ai.highlights.texttiling import (
    TextTileBoundary,
    TextTilingConfig,
    TextTilingResult,
    compute_texttiling,
    discourse_coherence_bonus,
)
from worker_ai.highlights.sponsors import (
    COMMERCIAL_SCORE_THRESHOLD,
    CommercialClassification,
    classify_commercial_intent,
    commercial_score,
    detect_intro_teasers,
    fetch_sponsorblock_segments_py,
    filter_commercial_windows,
    is_commercial_segment,
)
from worker_ai.highlights.tribe_client import (
    NeuralAttentionScore,
    TribeClient,
    TribeWindowInput,
)
from worker_ai.highlights.windows import (
    DISALLOWED_CLOSINGS,
    DISALLOWED_OPENINGS,
    DURATION_BINS_MS,
    Unit,
    Window,
    Word,
    build_units,
    discourse_opening_advance,
    enumerate_windows,
    filter_windows_by_duration,
    is_incomplete_closing,
    padded_windows,
    snap_to_silence,
    snap_to_silence_ms,
    snap_window_to_silence,
    snap_windows,
    words_to_silence_gaps,
)

__all__ = [
    "COMMERCIAL_SCORE_THRESHOLD",
    "CommercialClassification",
    "DISALLOWED_CLOSINGS",
    "DISALLOWED_OPENINGS",
    "DURATION_BINS_MS",
    "HIGHLIGHTS_SCHEMA_VERSION",
    "MAX_DURATION_MS",
    "MIN_DURATION_MS",
    "classify_commercial_intent",
    "commercial_score",
    "detect_intro_teasers",
    "fetch_sponsorblock_segments_py",
    "filter_commercial_windows",
    "filter_windows_by_duration",
    "is_commercial_segment",
    "DiagnosticItem",
    "HighlightProposal",
    "HighlightsOptions",
    "HighlightsPayload",
    "HighlightsResult",
    "NativeChapter",
    "NeuralAttentionScore",
    "ProposalReason",
    "ScoreBreakdown",
    "StorageObject",
    "TextTileBoundary",
    "TextTilingConfig",
    "TextTilingResult",
    "TribeClient",
    "TribeWindowInput",
    "Unit",
    "ViralityDiagnostic",
    "Window",
    "Word",
    "build_units",
    "compute_texttiling",
    "discourse_coherence_bonus",
    "discourse_opening_advance",
    "enumerate_windows",
    "highlights_job_key",
    "is_incomplete_closing",
    "padded_windows",
    "snap_to_silence",
    "snap_to_silence_ms",
    "snap_window_to_silence",
    "snap_windows",
    "words_to_silence_gaps",
]
