"""B10: the ``ai.clean`` audio-clean signal chain (see ``dsp.py`` and ``processor.py``)."""

from __future__ import annotations

from worker_ai.clean.dsp import CleanMetrics
from worker_ai.clean.processor import process_clean

__all__ = ["CleanMetrics", "process_clean"]
