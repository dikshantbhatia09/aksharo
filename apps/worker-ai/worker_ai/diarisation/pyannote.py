"""pyannote community-1 diarisation — the global diariser (decision **D13**).

Two facts about the model drive everything here:

* **Licence: CC-BY-4.0** on the ``pyannote/speaker-diarization-community-1``
  checkpoint — commercial use *with attribution*. The attribution obligation is
  not a footnote in a design document: :data:`PYANNOTE_ATTRIBUTION` is the string
  the worker puts into ``engineVersions`` on every diarised job and the README
  carries the same notice.
* **Run it globally.** `09 §2` requires whole-file diarisation so speaker ids
  survive the chunk boundaries the VAD planner introduces. A chunk-local diariser
  that renumbers speakers every ten minutes is worse than none, because the
  editor would show "Speaker 1" changing identity mid-video.

## Where it runs

The D15 model server keeps Whisper, the aligners and pyannote co-resident on the
serverless GPU, so this adapter is an **HTTP client**, the same shape as
``ServerlessWhisperProvider``:

```
POST {GPU_PROVIDER_URL}/diarise
Authorization: Bearer {GPU_PROVIDER_TOKEN}
{ "audio": "<https url or path>", "model": "pyannote/speaker-diarization-community-1",
  "numSpeakers": 2, "minSpeakers": 1, "maxSpeakers": 8 }

200 { "turns": [ { "speaker": "SPEAKER_00", "start": 0.0, "end": 4.12 } ],
      "model": "pyannote/speaker-diarization-community-1" }
```

Times on the wire are **seconds**; they become milliseconds here. Speaker labels
become the EDG's own opaque ``S1``/``S2`` ids, because ``SPEAKER_00`` is a
pyannote implementation detail that must not reach a caption.

A pod with no GPU endpoint reports itself unavailable and the registry falls
through to the single-speaker diariser, which is the right answer for the
one-person-to-camera footage that is most of this product's input.
"""

from __future__ import annotations

from typing import Any

from worker_ai.diarisation.base import Diariser
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    DiarisationRequest,
    DiarisedSpeaker,
    ProviderError,
    ProviderSubmission,
)

__all__ = [
    "PYANNOTE_ATTRIBUTION",
    "PYANNOTE_LICENCE",
    "PYANNOTE_MODEL",
    "PyannoteCommunityDiariser",
]

_log = get_logger(__name__)

#: The checkpoint decision D13 names.
PYANNOTE_MODEL = "pyannote/speaker-diarization-community-1"

PYANNOTE_LICENCE = "CC-BY-4.0"

#: Shipped in ``engineVersions`` and in the README; CC-BY-4.0 requires it.
PYANNOTE_ATTRIBUTION = (
    "Speaker diarisation by pyannote speaker-diarization-community-1 "
    "(Herve Bredin et al., CC-BY-4.0)."
)


class PyannoteCommunityDiariser(Diariser):
    """Whole-file speaker turns from the co-resident GPU model server."""

    name = "pyannote-community-1"
    rank = 10
    global_labels = True

    model = PYANNOTE_MODEL
    licence = PYANNOTE_LICENCE
    attribution = PYANNOTE_ATTRIBUTION

    def __init__(
        self,
        base_url: str = "",
        *,
        token: str = "",
        enabled: bool = True,
        http: Any = None,
    ) -> None:
        self._base_url = (base_url or "").rstrip("/")
        self._token = token
        self._enabled = enabled
        self._http = http
        #: External calls made, for the completion payload's submission trail.
        self.submissions: list[ProviderSubmission] = []

    def available(self) -> str | None:
        if not self._enabled:
            return "feature flag diarise.pyannote is off"
        if self._http is None and not self._base_url:
            return "GPU_PROVIDER_URL is not set, so the model server is unreachable"
        return None

    def drain_submissions(self) -> tuple[ProviderSubmission, ...]:
        """The calls made since the last drain; this diariser outlives the job."""
        drained = tuple(self.submissions)
        self.submissions.clear()
        return drained

    def _client(self) -> Any:
        if self._http is None:
            from worker_ai.providers.http import VendorHttp

            self._http = VendorHttp(
                provider=self.name,
                base_url=self._base_url,
                headers={"authorization": "Bearer " + self._token} if self._token else {},
            )
        return self._http

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        """One call over the whole file — never per chunk (`09 §2`)."""
        body: dict[str, Any] = {"audio": request.audio_uri, "model": self.model}
        if request.num_speakers is not None:
            body["numSpeakers"] = request.num_speakers
        if request.min_speakers is not None:
            body["minSpeakers"] = request.min_speakers
        if request.max_speakers is not None:
            body["maxSpeakers"] = request.max_speakers

        payload = await self._client().json("POST", "/diarise", json_body=body)
        self.submissions.append(
            ProviderSubmission(
                provider=self.name,
                endpoint=self._client().url("/diarise"),
                artefact=request.audio_uri,
                retention_class="ephemeral",
            )
        )
        turns = _turns(payload.get("turns"))
        if not turns and payload.get("turns") is not None:
            raise ProviderError(
                "the diariser returned an unreadable turn list",
                provider=self.name,
                retryable=False,
            )
        _log.info(
            "pyannote diarisation complete",
            extra={
                "turns": len(turns),
                "speakers": len({turn.speaker_id for turn in turns}),
                "model": self.model,
            },
        )
        return turns


def _turns(raw: object) -> tuple[DiarisedSpeaker, ...]:
    """``turns[]`` in seconds to :class:`DiarisedSpeaker` in milliseconds."""
    if not isinstance(raw, list):
        return ()
    turns: list[DiarisedSpeaker] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        label = _speaker(item.get("speaker") or item.get("label"))
        if label is None:
            continue
        start = round(float(item.get("start") or 0.0) * 1000)
        end = round(float(item.get("end") or 0.0) * 1000)
        if end <= start:
            continue
        confidence = item.get("confidence")
        turns.append(
            DiarisedSpeaker(
                speaker_id=label,
                start_ms=start,
                end_ms=end,
                confidence=round(float(confidence), 4)
                if isinstance(confidence, int | float)
                else None,
            )
        )
    return tuple(sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms)))


def _speaker(raw: object) -> str | None:
    """``SPEAKER_00`` becomes ``S1`` — pyannote's numbering never reaches a caption."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    label = raw.strip()
    tail = label.rsplit("_", 1)[-1]
    if tail.isdigit():
        return "S" + str(int(tail) + 1)
    return label
