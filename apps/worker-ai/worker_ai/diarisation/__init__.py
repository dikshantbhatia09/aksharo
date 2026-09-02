"""Diarisation registry (decision D13, `09 §2`)."""

from __future__ import annotations

from worker_ai.diarisation.base import DiarisationUnavailableError, Diariser, DiariserRegistry
from worker_ai.diarisation.noop import SINGLE_SPEAKER_ID, NoopDiariser
from worker_ai.diarisation.pyannote import PyannoteCommunityDiariser

__all__ = [
    "SINGLE_SPEAKER_ID",
    "DiarisationUnavailableError",
    "Diariser",
    "DiariserRegistry",
    "NoopDiariser",
    "PyannoteCommunityDiariser",
]
