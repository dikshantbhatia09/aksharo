"""The voice-over hook (2026-10-01, ``ai.voiceover``).

``contracts`` is the Pydantic mirror of ``ai.voiceover@1``; ``sarvam`` is the
vendor's text-to-speech API; ``worker_ai.processors.voiceover`` is the job.
"""

from worker_ai.voiceover.contracts import (
    VoiceoverCheckpoint,
    VoiceoverPayload,
    VoiceoverResult,
)
from worker_ai.voiceover.sarvam import (
    SARVAM_TTS_DEFAULT_BASE_URL,
    SarvamSpeechClient,
    SpeechVendorError,
    vendor_paise,
)

__all__ = [
    "SARVAM_TTS_DEFAULT_BASE_URL",
    "SarvamSpeechClient",
    "SpeechVendorError",
    "VoiceoverCheckpoint",
    "VoiceoverPayload",
    "VoiceoverResult",
    "vendor_paise",
]
