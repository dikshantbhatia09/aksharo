"""Single-speaker diarisation: the honest answer when nothing better is installed.

Most creator footage is one person talking to a camera, so "everything is S1" is
right far more often than it is wrong — and when it is wrong it is *visibly*
wrong, which is better than a wrong number of speakers that looks plausible.

It labels the VAD speech regions rather than the whole timeline, so a caller can
tell silence from speech in the result and the shape matches what pyannote will
return in A10.
"""

from __future__ import annotations

from worker_ai.diarisation.base import Diariser
from worker_ai.providers.base import DiarisationRequest, DiarisedSpeaker

__all__ = ["NoopDiariser"]

#: Speaker ids are opaque to the EDG; ``S1`` is what the editor shows by default.
SINGLE_SPEAKER_ID = "S1"


class NoopDiariser(Diariser):
    """One speaker over every speech region."""

    name = "noop-single-speaker"
    rank = 100
    global_labels = True

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        if not request.regions:
            return ()
        return tuple(
            DiarisedSpeaker(
                speaker_id=SINGLE_SPEAKER_ID,
                start_ms=start_ms,
                end_ms=end_ms,
                confidence=1.0,
            )
            for start_ms, end_ms in request.regions
            if end_ms > start_ms
        )
