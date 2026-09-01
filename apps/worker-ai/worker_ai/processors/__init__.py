"""Job processors, one module per queue."""

from __future__ import annotations

from worker_ai.processors.transcribe import process_transcribe

__all__ = ["process_transcribe"]
