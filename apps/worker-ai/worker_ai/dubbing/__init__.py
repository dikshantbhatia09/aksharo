"""Dubbing a clip into other languages (2026-10-04, ``ai.dub``).

``contracts`` is the Pydantic mirror of ``ai.dub@1``; ``sarvam`` is the vendor's
Dubbing API; ``worker_ai.processors.dub`` is the job itself.
"""

from worker_ai.dubbing.contracts import (
    DubCancelPayload,
    DubCancelResult,
    DubCheckpoint,
    DubRunPayload,
    DubRunResult,
    DubTrack,
    parse_dub_payload,
)
from worker_ai.dubbing.sarvam import (
    SARVAM_DUBBING_DEFAULT_BASE_URL,
    DubbingVendorError,
    SarvamDubbingClient,
)

__all__ = [
    "SARVAM_DUBBING_DEFAULT_BASE_URL",
    "DubCancelPayload",
    "DubCancelResult",
    "DubCheckpoint",
    "DubRunPayload",
    "DubRunResult",
    "DubTrack",
    "DubbingVendorError",
    "SarvamDubbingClient",
    "parse_dub_payload",
]
