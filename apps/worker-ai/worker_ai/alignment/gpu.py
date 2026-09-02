"""Forced alignment on the A26 model server — the rung a CPU pod actually uses.

The two rungs above this one (:mod:`~worker_ai.alignment.indic_wav2vec` and
:mod:`~worker_ai.alignment.xlsr`) run CTC checkpoints **in this process**, which
means a pod that wants them has to carry a few hundred megabytes of ONNX. The
``ai.*`` worker pool is the CPU pool, and it is already talking to
``apps/model-server`` for ASR (``/transcribe``), diarisation (``/diarise``) and
LID signal 1 (``/detect-language``) — where the same checkpoints are already
resident on the GPU, baked into the image by
``apps/model-server/scripts/bake_models.py``.

So this rung asks that server to do it, and sits **below** the local rungs and
**above** the paid one:

```
IndicWav2Vec  (20)  local ONNX, MIT,        Indic
XLSR-53       (30)  local ONNX, Apache-2.0, global
GPU aligner   (35)  the model server, both families, no local weights
ElevenLabs FA (40)  paid, per minute
proportional (100)  no model, never missing
```

Local first because a CPU-side Viterbi pass costs nothing beyond the pod it is
already running in, while this one spends GPU-seconds that `05 §12` counts. Paid
last, for the obvious reason.

## Wire contract (recorded, not described)

``worker_ai/fixtures/vendor/gpu-whisper/session.json`` holds a **real** response
from ``apps/model-server``, produced by driving its own test client — so this
adapter is written against the server's output rather than against prose about
it, and A26's ``test_contract_fixtures.py`` reads the same file from the other
side.

```
POST {GPU_PROVIDER_URL}/align
Authorization: Bearer {GPU_PROVIDER_TOKEN}
{ "audio": "<uri>", "words": ["toh", "aaj"], "language": "hi",
  "startS": 0.0, "endS": 4.0 }

200 { "language": "hi", "model": "ai4bharat/indicwav2vec/hi", "licence": "MIT",
      "durationS": 4.0, "requestId": "...",
      "words": [ { "start": 0.0, "end": 0.4, "word": "toh", "probability": 1.0 } ],
      "skipped": [], "engineVersions": {...}, "usage": {...} }
```

Three things about that response drive the code below:

* **Words come back in file time.** The server adds ``startS`` itself, so this
  adapter applies only the caller's ``offset_ms`` and must not add the span start
  a second time.
* **There is always one word per input word**, even for a word the checkpoint's
  vocabulary could not represent: that word gets ``probability: 0.0`` and its
  text is listed in ``skipped``. Nothing has to be reinserted, and the
  :class:`~worker_ai.alignment.base.Aligner` contract — one word out per word in,
  in order — holds by construction. A response that breaks it is a hard failure
  rather than a silently shifted transcript.
* **``licence`` is per checkpoint**, so it is recorded and surfaced through
  ``engineVersions``: MIT for the Indic family, Apache-2.0 for XLSR-53, and never
  MMS (D77).
"""

from __future__ import annotations

from typing import Any

from worker_ai.alignment.base import Aligner
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    AlignmentRequest,
    ProviderError,
    ProviderSubmission,
    Word,
)
from worker_ai.vad import SpeechRegion

__all__ = ["GpuCtcAligner"]

_log = get_logger(__name__)


class GpuCtcAligner(Aligner):
    """``POST /align`` on the model server, behind the D13 registry's interface."""

    name = "gpu-ctc"
    rank = 35
    #: Empty means "any": the server picks the checkpoint family per language and
    #: answers with a reason when it has none, which the caller turns into a
    #: fall-through to the next rung.
    languages = ()

    model = "apps/model-server /align"
    licence = "MIT (IndicWav2Vec) / Apache-2.0 (XLSR-53)"

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
        #: External calls made, drained onto the job's completion payload.
        self.submissions: list[ProviderSubmission] = []
        #: The checkpoint the server last used, for ``engineVersions``.
        self.last_model = ""
        self.last_licence = ""

    def available(self) -> str | None:
        if not self._enabled:
            return "feature flag align.gpu is off"
        if self._http is None and not self._base_url:
            return "GPU_PROVIDER_URL is not set, so the model server is unreachable"
        return None

    def _client(self) -> Any:
        if self._http is None:
            from worker_ai.providers.http import VendorHttp

            self._http = VendorHttp(
                provider=self.name,
                base_url=self._base_url,
                headers={"authorization": "Bearer " + self._token} if self._token else {},
            )
        return self._http

    def drain_submissions(self) -> tuple[ProviderSubmission, ...]:
        """The calls made since the last drain; this aligner outlives the job."""
        drained = tuple(self.submissions)
        self.submissions.clear()
        return drained

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        """Send the span and its known words; return one timing per word."""
        del regions  # the server aligns against the audio, not against our VAD
        if not request.words:
            return ()
        if not request.audio_uri:
            raise ProviderError(
                "the model server aligns audio; the payload named none",
                provider=self.name,
                retryable=False,
            )

        body: dict[str, Any] = {
            "audio": request.audio_uri,
            "words": list(request.words),
            "language": request.language,
            "startS": request.start_ms / 1000,
        }
        if request.end_ms is not None:
            body["endS"] = request.end_ms / 1000

        payload = await self._client().json("POST", "/align", json_body=body)
        self.last_model = str(payload.get("model") or "")
        self.last_licence = str(payload.get("licence") or "")
        self.submissions.append(
            ProviderSubmission(
                provider=self.name,
                endpoint=self._client().url("/align"),
                artefact=request.audio_uri,
                external_ref=str(payload.get("requestId") or "") or None,
                retention_class="ephemeral",
            )
        )

        words = _words(payload.get("words"), request.offset_ms)
        if len(words) != len(request.words):
            # The caller indexes by position; a short list is a shifted transcript.
            raise ProviderError(
                "the model server returned "
                + str(len(words))
                + " timings for "
                + str(len(request.words))
                + " words",
                provider=self.name,
                retryable=False,
            )

        skipped = [str(item) for item in payload.get("skipped") or [] if str(item)]
        if skipped:
            # Not a failure: a word the checkpoint cannot represent still gets a
            # span, at probability 0, so the editor can flag it (`09 §2`).
            _log.info(
                "some words were outside the aligner vocabulary",
                extra={
                    "aligner": self.name,
                    "model": self.last_model,
                    "skipped": len(skipped),
                    "words": len(words),
                },
            )
        return words


def _words(raw: object, offset_ms: int) -> tuple[Word, ...]:
    """``words[]`` in seconds to EDG words in milliseconds, already in file time.

    Deliberately the same shape ``/transcribe`` returns — A26 kept it identical so
    one parser reads both.
    """
    if not isinstance(raw, list):
        return ()
    words: list[Word] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("word") or item.get("text") or "").strip()
        if not text:
            continue
        probability = item.get("probability")
        words.append(
            Word(
                s=offset_ms + round(float(item.get("start") or 0.0) * 1000),
                e=offset_ms + round(float(item.get("end") or 0.0) * 1000),
                t=text,
                c=round(float(probability), 4) if isinstance(probability, int | float) else None,
            )
        )
    return tuple(words)
