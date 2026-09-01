"""pyannote community-1 diarisation — **A10 implements this**.

Decision **D13** picks this model specifically, and two facts about it drive the
implementation A10 will write:

* **Licence: CC-BY-4.0** on the community-1 checkpoint. Attribution is required
  wherever the output is shipped, which is why the licence is a module constant
  rather than a line in a design document.
* **Run it globally.** `09 §2` requires whole-file diarisation (or chunk-local
  labels clustered by speaker embeddings) so speaker ids survive the chunk
  boundaries the VAD planner introduces.

The model server co-hosts this with Whisper and the aligners on the serverless GPU
(D15), so the A10 adapter is most likely an HTTP client rather than an in-process
model — the same shape as ``ServerlessWhisperProvider``.
"""

from __future__ import annotations

from worker_ai.diarisation.base import Diariser
from worker_ai.providers.base import DiarisationRequest, DiarisedSpeaker

__all__ = ["PyannoteCommunityDiariser"]


class PyannoteCommunityDiariser(Diariser):
    """Diariser shell: model name, licence and run mode (A10)."""

    name = "pyannote-community-1"
    rank = 10
    global_labels = True

    #: The checkpoint decision D13 names.
    model = "pyannote/speaker-diarization-community-1"
    licence = "CC-BY-4.0"

    def available(self) -> str | None:
        return "the pyannote community-1 diariser lands in A10"

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("pyannote community-1 diarisation lands in A10")
