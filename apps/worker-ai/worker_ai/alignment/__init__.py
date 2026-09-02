"""Forced-alignment registry (decision D13, `09 §2`)."""

from __future__ import annotations

from worker_ai.alignment.base import Aligner, AlignerRegistry, AlignmentUnavailableError
from worker_ai.alignment.elevenlabs_fa import ElevenLabsForcedAligner
from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
from worker_ai.alignment.mms import MmsAligner
from worker_ai.alignment.proportional import ProportionalAligner, distribute

__all__ = [
    "Aligner",
    "AlignerRegistry",
    "AlignmentUnavailableError",
    "ElevenLabsForcedAligner",
    "IndicWav2VecAligner",
    "MmsAligner",
    "ProportionalAligner",
    "distribute",
]
