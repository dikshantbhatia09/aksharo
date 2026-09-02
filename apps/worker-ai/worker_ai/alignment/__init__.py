"""Forced-alignment registry (decision D13, `09 §2`)."""

from __future__ import annotations

from worker_ai.alignment.base import Aligner, AlignerRegistry, AlignmentUnavailableError
from worker_ai.alignment.ctc import CtcAligner, TokenSpan, forced_align, word_spans
from worker_ai.alignment.elevenlabs_fa import ElevenLabsForcedAligner
from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
from worker_ai.alignment.mms import MmsAligner
from worker_ai.alignment.proportional import ProportionalAligner, distribute
from worker_ai.alignment.romanisation import romanise, to_devanagari

__all__ = [
    "Aligner",
    "AlignerRegistry",
    "AlignmentUnavailableError",
    "CtcAligner",
    "ElevenLabsForcedAligner",
    "IndicWav2VecAligner",
    "MmsAligner",
    "ProportionalAligner",
    "TokenSpan",
    "distribute",
    "forced_align",
    "romanise",
    "to_devanagari",
    "word_spans",
]
