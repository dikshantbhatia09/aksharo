"""Provider adapters. A01 defines the interface; A09 and A10 add implementations."""

from __future__ import annotations

from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapability,
    ProviderError,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

__all__ = [
    "AlignmentRequest",
    "DiarisationRequest",
    "DiarisedSpeaker",
    "Provider",
    "ProviderCapability",
    "ProviderError",
    "ProviderUsage",
    "TranscriptionRequest",
    "TranscriptionResult",
    "Word",
]
