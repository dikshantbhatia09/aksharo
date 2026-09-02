"""Job processors, one module per queue."""

from __future__ import annotations

from worker_ai.processors.align import process_align
from worker_ai.processors.context import (
    JobContext,
    JobFailureError,
    ProcessorOutcome,
    Services,
)
from worker_ai.processors.diarise import process_diarise
from worker_ai.processors.llm import process_llm
from worker_ai.processors.not_implemented import OWNERS, process_not_implemented
from worker_ai.processors.transcribe import process_transcribe
from worker_ai.processors.translate import process_translate
from worker_ai.processors.transliterate import process_transliterate
from worker_ai.processors.vad import process_vad

__all__ = [
    "OWNERS",
    "JobContext",
    "JobFailureError",
    "ProcessorOutcome",
    "Services",
    "process_align",
    "process_diarise",
    "process_llm",
    "process_not_implemented",
    "process_transcribe",
    "process_translate",
    "process_transliterate",
    "process_vad",
]
