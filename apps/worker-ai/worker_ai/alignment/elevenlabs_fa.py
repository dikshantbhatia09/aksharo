"""ElevenLabs Forced Alignment — rung 4 of the `09 §2` chain, and the paid one.

Used when no self-hosted CTC head serves the language and the proportional
fallback would miss the onset target. It is the only rung with a per-minute price
(₹0.35/min at the STT rate, RR-02 F5), so the registry reaches it last — after
IndicWav2Vec and MMS, before proportional.

It is also the only rung that **sends audio to a third party**, so it is disabled
unless ``ELEVENLABS_API_KEY`` is configured *and* the ``align.elevenlabs`` flag is
on, and every call it makes is recorded as a :class:`ProviderSubmission` on the
job's completion payload so an erasure request can find it (`06 §Invariant 5`).
"""

from __future__ import annotations

from worker_ai.alignment.base import Aligner
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import AlignmentRequest, ProviderError, ProviderSubmission, Word
from worker_ai.providers.elevenlabs import ElevenLabsScribeProvider
from worker_ai.vad import SpeechRegion

__all__ = ["ElevenLabsForcedAligner"]

_log = get_logger(__name__)


class ElevenLabsForcedAligner(Aligner):
    """The vendor's Forced Alignment endpoint, behind the registry's interface."""

    name = "elevenlabs-fa"
    rank = 40
    #: 29 languages including Hindi (RR-02 F5); the empty tuple means the
    #: registry offers it for anything and the vendor refuses what it cannot do.
    languages = ()

    model = "eleven-forced-alignment-v1"
    #: ₹0.03 per media minute alongside a Saaras transcript (`09 §1`).
    cost_per_minute_inr = 0.03

    def __init__(
        self,
        api_key: str = "",
        *,
        provider: ElevenLabsScribeProvider | None = None,
        enabled: bool = True,
    ) -> None:
        self._api_key = api_key
        self._provider = provider
        self._enabled = enabled
        #: External calls this aligner made, for the completion payload.
        self.submissions: list[ProviderSubmission] = []

    def available(self) -> str | None:
        if not self._enabled:
            return "feature flag align.elevenlabs is off"
        if self._provider is None and not self._api_key:
            return "ELEVENLABS_API_KEY is not set"
        return None

    def _client(self) -> ElevenLabsScribeProvider:
        if self._provider is None:
            self._provider = ElevenLabsScribeProvider(self._api_key)
        return self._provider

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        """Send the span's audio and its known text; return word timings."""
        del regions  # the vendor aligns against the audio, not against our VAD
        if not request.words:
            return ()
        result = await self._client().align(request)
        self.submissions.extend(result.submissions)
        if len(result.words) != len(request.words):
            # A mismatch means the vendor re-tokenised the text; the caller
            # indexes by position, so this is a hard failure rather than a
            # silently shifted transcript.
            raise ProviderError(
                "Forced Alignment returned "
                + str(len(result.words))
                + " words for "
                + str(len(request.words))
                + " inputs",
                provider="elevenlabs",
                retryable=False,
            )
        return result.words

    async def aclose(self) -> None:
        """Close the client this aligner created."""
        if self._provider is not None:
            await self._provider.aclose()
