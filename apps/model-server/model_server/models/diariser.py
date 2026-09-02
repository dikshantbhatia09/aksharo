"""pyannote community-1 diarisation, with the attribution its licence requires.

Two facts drive this file, and they are the same two that drive
``apps/worker-ai/worker_ai/diarisation/pyannote.py``:

* **Licence: CC-BY-4.0.** ``pyannote/speaker-diarization-community-1`` permits
  commercial use *with attribution*, and D77 is explicit that the attribution is
  surfaced in ``engineVersions``. :data:`PYANNOTE_ATTRIBUTION` is byte-identical
  to the worker's constant on purpose: two copies of an attribution string that
  drift are two chances to ship the wrong one, so the contract test asserts they
  match.
* **Run it over the whole file.** `09 §2` requires whole-file diarisation so
  speaker ids survive the chunk boundaries the VAD planner introduces. A
  chunk-local diariser that renumbers speakers every ten minutes is worse than
  none, because the editor would show "Speaker 1" changing identity mid-video.
  So ``/diarise`` is **not batched**: one call holds one whole file, and its
  memory reservation asks for more per audio-second than transcription does.

The weights are gated on Hugging Face. They are fetched once at image-build time
with an ``HF_TOKEN`` BuildKit secret (``apps/model-server/scripts/bake_models.py``) and
read here from the local cache with ``HF_HUB_OFFLINE=1``; nothing in this file
reaches the network.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np

from model_server.logging_setup import get_logger
from model_server.models.base import DiariseJob, DiariserBackend, SpeakerTurn

__all__ = [
    "PYANNOTE_ATTRIBUTION",
    "PYANNOTE_LICENCE",
    "PYANNOTE_MODEL",
    "PyannoteDiariser",
]

_log = get_logger(__name__)

#: The checkpoint decisions D13 and D77 name.
PYANNOTE_MODEL = "pyannote/speaker-diarization-community-1"

PYANNOTE_LICENCE = "CC-BY-4.0"

#: Identical to ``worker_ai.diarisation.pyannote.PYANNOTE_ATTRIBUTION``.
PYANNOTE_ATTRIBUTION = (
    "Speaker diarisation by pyannote speaker-diarization-community-1 "
    "(Herve Bredin et al., CC-BY-4.0)."
)


class PyannoteDiariser(DiariserBackend):
    """Whole-file speaker turns from the co-resident pyannote pipeline."""

    kind = "diarise"
    model_id = PYANNOTE_MODEL
    licence = PYANNOTE_LICENCE
    attribution = PYANNOTE_ATTRIBUTION

    def __init__(
        self,
        model_id: str = PYANNOTE_MODEL,
        *,
        device: str = "cuda",
        auth_token: str = "",
    ) -> None:
        self.model_id = model_id
        self.device = device
        self._auth_token = auth_token
        self._pipeline: Any = None
        # pyannote's pipeline object is not re-entrant; one file at a time.
        self._lock = threading.Lock()

    def unavailable(self) -> str | None:
        try:
            import pyannote.audio  # noqa: F401
        except ImportError:
            return (
                "pyannote.audio is not installed; it ships in requirements-gpu.lock "
                "and is not part of the CPU lane"
            )
        return None

    def load(self) -> None:
        """Instantiate the pipeline from the baked cache and move it to the device."""
        reason = self.unavailable()
        if reason is not None:
            raise RuntimeError(reason)
        from pyannote.audio import Pipeline

        started = time.perf_counter()
        pipeline = Pipeline.from_pretrained(self.model_id, use_auth_token=self._auth_token or None)
        if pipeline is None:
            raise RuntimeError(
                self.model_id
                + " returned no pipeline. The usual cause is an unaccepted licence on "
                "the Hugging Face model page; the image build fails on the same thing."
            )
        if self.device != "cpu":  # pragma: no cover - needs a card
            import torch

            pipeline = pipeline.to(torch.device(self.device))
        self._pipeline = pipeline
        self._ready = True
        _log.info(
            "pyannote loaded",
            extra={
                "model": self.model_id,
                "device": self.device,
                "licence": self.licence,
                "loadSeconds": round(time.perf_counter() - started, 3),
            },
        )

    def unload(self) -> None:
        self._ready = False
        self._pipeline = None

    def diarise(  # pragma: no cover - needs the gated weights
        self, job: DiariseJob
    ) -> tuple[SpeakerTurn, ...]:
        """One call over the whole file — never per chunk (`09 §2`)."""
        if self._pipeline is None:
            raise RuntimeError("the diarisation pipeline is not loaded")
        import torch

        waveform = torch.from_numpy(
            np.ascontiguousarray(job.samples, dtype=np.float32)[np.newaxis, :]
        )
        options: dict[str, Any] = {}
        if job.num_speakers is not None:
            options["num_speakers"] = job.num_speakers
        if job.min_speakers is not None:
            options["min_speakers"] = job.min_speakers
        if job.max_speakers is not None:
            options["max_speakers"] = job.max_speakers

        with self._lock:
            annotation = self._pipeline(
                {"waveform": waveform, "sample_rate": job.sample_rate}, **options
            )
        return _turns(annotation)


def _turns(annotation: Any) -> tuple[SpeakerTurn, ...]:  # pragma: no cover - needs weights
    """pyannote's ``Annotation`` to the wire's turn list, sorted by start."""
    turns: list[SpeakerTurn] = []
    for segment, _track, label in annotation.itertracks(yield_label=True):
        start = float(getattr(segment, "start", 0.0) or 0.0)
        end = float(getattr(segment, "end", 0.0) or 0.0)
        if end <= start:
            continue
        turns.append(SpeakerTurn(speaker=str(label), start=round(start, 3), end=round(end, 3)))
    return tuple(sorted(turns, key=lambda turn: (turn.start, turn.end)))
