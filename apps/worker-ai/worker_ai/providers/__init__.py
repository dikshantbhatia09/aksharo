"""Provider adapters: the interface, the registry, and the A09 implementations."""

from __future__ import annotations

from worker_ai.providers.assemblyai import AssemblyAiProvider
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    ProviderCapability,
    ProviderCost,
    ProviderError,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)
from worker_ai.providers.elevenlabs import ElevenLabsScribeProvider
from worker_ai.providers.local_whisper import LocalWhisperProvider
from worker_ai.providers.mock import MOCK_HINGLISH_SAMPLE, MockProvider
from worker_ai.providers.registry import (
    ProviderRegistry,
    ProviderStatus,
    ProviderUnavailableError,
    build_registry,
)
from worker_ai.providers.sarvam import SarvamSaarasProvider
from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider

__all__ = [
    "MOCK_HINGLISH_SAMPLE",
    "AlignmentRequest",
    "AssemblyAiProvider",
    "DiarisationRequest",
    "DiarisedSpeaker",
    "ElevenLabsScribeProvider",
    "LocalWhisperProvider",
    "MockProvider",
    "Provider",
    "ProviderCapabilities",
    "ProviderCapability",
    "ProviderCost",
    "ProviderError",
    "ProviderRegistry",
    "ProviderStatus",
    "ProviderSubmission",
    "ProviderUnavailableError",
    "ProviderUsage",
    "SarvamSaarasProvider",
    "ServerlessWhisperProvider",
    "TranscriptionRequest",
    "TranscriptionResult",
    "Word",
    "build_registry",
]
