"""Diarisation registry (decision D13, `09 §2`)."""

from __future__ import annotations

from worker_ai.diarisation.base import DiarisationUnavailableError, Diariser, DiariserRegistry
from worker_ai.diarisation.mapping import (
    SpeakerMapping,
    assign_speakers,
    parse_rttm,
    speaker_ids,
)
from worker_ai.diarisation.noop import SINGLE_SPEAKER_ID, NoopDiariser
from worker_ai.diarisation.pyannote import (
    PYANNOTE_ATTRIBUTION,
    PYANNOTE_LICENCE,
    PYANNOTE_MODEL,
    PyannoteCommunityDiariser,
)

__all__ = [
    "PYANNOTE_ATTRIBUTION",
    "PYANNOTE_LICENCE",
    "PYANNOTE_MODEL",
    "SINGLE_SPEAKER_ID",
    "DiarisationUnavailableError",
    "Diariser",
    "DiariserRegistry",
    "NoopDiariser",
    "PyannoteCommunityDiariser",
    "SpeakerMapping",
    "assign_speakers",
    "parse_rttm",
    "speaker_ids",
]
