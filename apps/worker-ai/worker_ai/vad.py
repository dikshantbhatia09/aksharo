"""Voice activity detection: speech regions for chunking, alignment and autocut.

Two backends behind one interface:

* :class:`SileroOnnxVad` — Silero VAD v5 through **onnxruntime**, deliberately
  torch-free (`09 §1.1`). The 2 MB model is not committed; point
  ``WORKER_AI_VAD_MODEL`` at it (the Docker image bakes it in).
* :class:`EnergyVad` — a short-time energy detector with the same framing,
  hysteresis and post-processing. It is what runs when no model file is present,
  which is every developer machine and CI, and it is deterministic, so the chunk
  planner's tests do not depend on a model download.

Both produce frame probabilities; :func:`regions_from_probabilities` turns those
into speech regions, so the thresholds, the minimum durations and the padding are
defined once and tested once.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from worker_ai.audio import TARGET_SAMPLE_RATE, Pcm
from worker_ai.logging_setup import get_logger

__all__ = [
    "FRAME_SAMPLES",
    "VAD_DEFAULTS",
    "EnergyVad",
    "OnnxSession",
    "SileroOnnxVad",
    "SpeechRegion",
    "VadBackend",
    "VadSettings",
    "detect_regions",
    "load_vad",
    "regions_from_probabilities",
    "silence_gaps",
    "total_speech_ms",
]

_log = get_logger(__name__)

#: Silero v5 consumes exactly 512 samples (32 ms) per step at 16 kHz. The energy
#: backend uses the same window so the two are interchangeable downstream.
FRAME_SAMPLES = 512


@dataclass(frozen=True, slots=True)
class SpeechRegion:
    """One contiguous stretch of speech, in milliseconds from the file start."""

    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        if self.end_ms < self.start_ms:
            raise ValueError("a speech region cannot end before it starts")

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms

    def contains(self, at_ms: int) -> bool:
        """True when ``at_ms`` falls strictly inside the region."""
        return self.start_ms < at_ms < self.end_ms

    def to_wire(self) -> dict[str, int]:
        return {"startMs": self.start_ms, "endMs": self.end_ms}


@dataclass(frozen=True, slots=True)
class VadSettings:
    """Thresholds shared by both backends."""

    #: Probability above which a frame is speech.
    threshold: float = 0.5
    #: Probability below which speech ends (hysteresis stops flapping mid-word).
    release_threshold: float = 0.35
    #: Regions shorter than this are noise.
    min_speech_ms: int = 250
    #: Gaps shorter than this do not split a region.
    min_silence_ms: int = 100
    #: Symmetric padding, clamped to the file.
    speech_pad_ms: int = 30


VAD_DEFAULTS = VadSettings()


@runtime_checkable
class VadBackend(Protocol):
    """A detector that scores 32 ms frames."""

    name: str

    def probabilities(self, pcm: Pcm) -> NDArray[np.float32]:
        """One speech probability per :data:`FRAME_SAMPLES` frame."""
        ...


def _frames(pcm: Pcm) -> NDArray[np.float32]:
    """Split into non-overlapping frames, zero-padding the tail."""
    total = len(pcm.samples)
    if total == 0:
        return np.zeros((0, FRAME_SAMPLES), dtype=np.float32)
    count = math.ceil(total / FRAME_SAMPLES)
    padded = np.zeros(count * FRAME_SAMPLES, dtype=np.float32)
    padded[:total] = pcm.samples
    return padded.reshape(count, FRAME_SAMPLES)


class EnergyVad:
    """Short-time energy scored against the clip's own noise floor and peak.

    Not a substitute for Silero on real speech — it is a substitute for *nothing*,
    which is what a machine without the model file would otherwise have. It is
    also what the chunk-planner tests run on, so it has to be predictable rather
    than clever.

    The decision is made in decibels and relative to the clip, so recording gain
    does not change the answer:

    * ``floor`` is the 5th percentile of frame energy, ``peak`` the 95th — low
      enough that a monologue with only a twentieth of it silence still finds
      its noise floor;
    * when the two are within :attr:`min_range_db` the clip is uniform — all
      speech if it is louder than :attr:`absolute_silence_db`, otherwise all
      silence — which is the case a percentile split gets catastrophically wrong;
    * otherwise the band between 25 % and 60 % of the way from floor to peak is
      mapped onto ``[0, 1]``, and the shared hysteresis does the rest.
    """

    name = "energy"

    def __init__(
        self,
        *,
        noise_quantile: float = 0.05,
        peak_quantile: float = 0.95,
        min_range_db: float = 6.0,
        absolute_silence_db: float = -50.0,
    ) -> None:
        self._noise_quantile = noise_quantile
        self._peak_quantile = peak_quantile
        self.min_range_db = min_range_db
        self.absolute_silence_db = absolute_silence_db

    def probabilities(self, pcm: Pcm) -> NDArray[np.float32]:
        frames = _frames(pcm)
        if frames.shape[0] == 0:
            return np.zeros(0, dtype=np.float32)
        rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1)) + 1e-10
        decibels = 20.0 * np.log10(rms)

        floor = float(np.quantile(decibels, self._noise_quantile))
        peak = float(np.quantile(decibels, self._peak_quantile))
        if peak - floor < self.min_range_db:
            fill = 1.0 if peak > self.absolute_silence_db else 0.0
            return np.full(frames.shape[0], fill, dtype=np.float32)

        span = peak - floor
        low = floor + 0.25 * span
        high = floor + 0.60 * span
        return np.clip((decibels - low) / (high - low), 0.0, 1.0).astype(np.float32)


class OnnxSession(Protocol):
    """The slice of ``onnxruntime.InferenceSession`` this module uses."""

    def run(self, output_names: list[str] | None, input_feed: dict[str, Any]) -> list[Any]:
        """Execute the graph."""
        ...


class SileroOnnxVad:
    """Silero VAD v5, ONNX, stateful across frames.

    The v5 graph takes ``input`` ``[batch, 512]``, a recurrent ``state``
    ``[2, batch, 128]`` and an int64 ``sr``, and returns the speech probability
    plus the next state. Keeping the state is what makes it a sequence model
    rather than 512-sample guesses, so the loop below is the whole adapter.
    """

    name = "silero-v5"

    def __init__(self, session: OnnxSession, *, model_path: str | None = None) -> None:
        self._session = session
        self.model_path = model_path

    @classmethod
    def from_path(cls, path: Path) -> SileroOnnxVad:
        """Load ``silero_vad.onnx`` with a single-threaded CPU session."""
        import onnxruntime

        options = onnxruntime.SessionOptions()
        # One job already owns a whole core here; letting ORT fan out would fight
        # the worker's own chunk parallelism.
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        session = onnxruntime.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        return cls(session, model_path=str(path))

    def probabilities(self, pcm: Pcm) -> NDArray[np.float32]:
        frames = _frames(pcm)
        if frames.shape[0] == 0:
            return np.zeros(0, dtype=np.float32)
        state = np.zeros((2, 1, 128), dtype=np.float32)
        sample_rate = np.array(pcm.sample_rate, dtype=np.int64)
        scores = np.zeros(frames.shape[0], dtype=np.float32)
        for index in range(frames.shape[0]):
            outputs = self._session.run(
                None,
                {
                    "input": frames[index : index + 1].astype(np.float32),
                    "state": state,
                    "sr": sample_rate,
                },
            )
            scores[index] = float(np.asarray(outputs[0]).reshape(-1)[0])
            state = np.asarray(outputs[1], dtype=np.float32)
        return scores


def load_vad(model_path: str = "") -> VadBackend:
    """Silero when a model file is configured and loadable, else the energy VAD."""
    if model_path:
        candidate = Path(model_path)
        if candidate.is_file():
            try:
                return SileroOnnxVad.from_path(candidate)
            except Exception as error:  # a bad file must not take the worker down
                _log.warning(
                    "falling back to the energy VAD",
                    extra={"reason": type(error).__name__, "model": candidate.name},
                )
        else:
            _log.warning("VAD model not found", extra={"model": model_path})
    return EnergyVad()


def regions_from_probabilities(
    probabilities: NDArray[np.float32],
    *,
    sample_rate: int = TARGET_SAMPLE_RATE,
    duration_ms: int | None = None,
    settings: VadSettings = VAD_DEFAULTS,
) -> tuple[SpeechRegion, ...]:
    """Turn per-frame probabilities into padded, merged speech regions.

    Hysteresis first (``threshold`` to open, ``release_threshold`` to close), then
    merge gaps under ``min_silence_ms``, drop regions under ``min_speech_ms``, pad
    by ``speech_pad_ms``, and merge again in case padding closed a gap.
    """
    frame_ms = 1000 * FRAME_SAMPLES / sample_rate
    limit = duration_ms if duration_ms is not None else int(len(probabilities) * frame_ms)

    raw: list[list[int]] = []
    speaking = False
    for index, score in enumerate(probabilities):
        if not speaking and score >= settings.threshold:
            raw.append([int(index * frame_ms), int((index + 1) * frame_ms)])
            speaking = True
        elif speaking and score < settings.release_threshold:
            speaking = False
        elif speaking:
            raw[-1][1] = int((index + 1) * frame_ms)

    merged = _merge(raw, settings.min_silence_ms)
    kept = [span for span in merged if span[1] - span[0] >= settings.min_speech_ms]
    padded = [
        [max(0, span[0] - settings.speech_pad_ms), min(limit, span[1] + settings.speech_pad_ms)]
        for span in kept
    ]
    return tuple(SpeechRegion(start_ms=span[0], end_ms=span[1]) for span in _merge(padded, 0))


def _merge(spans: list[list[int]], min_gap_ms: int) -> list[list[int]]:
    """Join spans separated by less than ``min_gap_ms``."""
    out: list[list[int]] = []
    for span in spans:
        if out and span[0] - out[-1][1] <= min_gap_ms:
            out[-1][1] = max(out[-1][1], span[1])
        else:
            out.append([span[0], span[1]])
    return out


def silence_gaps(
    regions: tuple[SpeechRegion, ...], duration_ms: int
) -> tuple[tuple[int, int], ...]:
    """The complement of ``regions`` inside ``[0, duration_ms]``."""
    gaps: list[tuple[int, int]] = []
    cursor = 0
    for region in regions:
        if region.start_ms > cursor:
            gaps.append((cursor, min(region.start_ms, duration_ms)))
        cursor = max(cursor, region.end_ms)
        if cursor >= duration_ms:
            break
    if cursor < duration_ms:
        gaps.append((cursor, duration_ms))
    return tuple(gap for gap in gaps if gap[1] > gap[0])


def total_speech_ms(regions: tuple[SpeechRegion, ...]) -> int:
    """Sum of region durations — the billable "speech seconds" of a file."""
    return sum(region.duration_ms for region in regions)


def detect_regions(
    backend: VadBackend, pcm: Pcm, *, settings: VadSettings = VAD_DEFAULTS
) -> tuple[SpeechRegion, ...]:
    """Run a backend over ``pcm`` and post-process into regions."""
    return regions_from_probabilities(
        backend.probabilities(pcm),
        sample_rate=pcm.sample_rate,
        duration_ms=pcm.duration_ms,
        settings=settings,
    )
