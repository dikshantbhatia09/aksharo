"""faster-whisper on the CPU: the local lane and the offline fallback.

`09 §1` routes global languages to a self-hosted ``large-v3-turbo`` on serverless
GPU. This adapter is the same model family run in-process, which is what makes a
developer machine, a CI box and the eval harness able to produce a real transcript
with no vendor account at all.

``faster-whisper`` is an **optional** dependency (``pip install -e ".[local-asr]"``,
and the CPU Docker image installs it): it drags in CTranslate2 and downloads model
weights on first use, neither of which belongs in the unit-test path. The import
therefore happens inside :meth:`LocalWhisperProvider._model`, and the adapter is
still fully testable because the model factory is injectable.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterable
from typing import Any, Protocol

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    AlignmentRequest,
    DiarisationRequest,
    DiarisedSpeaker,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderSubmission,
    ProviderUsage,
    TranscriptionRequest,
    TranscriptionResult,
    Word,
)

__all__ = ["LocalWhisperProvider", "WhisperModel", "words_from_segments"]

_log = get_logger(__name__)


class WhisperModel(Protocol):
    """The slice of ``faster_whisper.WhisperModel`` this adapter uses."""

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Iterable[Any], Any]:
        """Return ``(segments, info)``; segments stream lazily."""
        ...


def _val(obj: Any, key: str, default: Any = None) -> Any:
    """Read a field from either a dict or an object attribute."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _ms(seconds: float | None, offset_ms: int) -> int:
    """Whisper talks in float seconds; the EDG talks in integer milliseconds."""
    return offset_ms + round((seconds or 0.0) * 1000)


def words_from_segments(segments: Iterable[Any], offset_ms: int) -> tuple[Word, ...]:
    """Flatten segment/word tree into ordered :class:`Word` values.

    Handles both faster-whisper objects and official openai-whisper dictionaries.
    """
    words: list[Word] = []
    for segment in segments:
        segment_words = _val(segment, "words") or []
        if segment_words:
            for word in segment_words:
                text = str(_val(word, "word", "")).strip()
                if not text:
                    continue
                probability = _val(word, "probability")
                words.append(
                    Word(
                        s=_ms(_val(word, "start"), offset_ms),
                        e=_ms(_val(word, "end"), offset_ms),
                        t=text,
                        c=round(float(probability), 4) if probability is not None else None,
                    )
                )
            continue
        text = str(_val(segment, "text", "")).strip()
        if text:
            words.append(
                Word(
                    s=_ms(_val(segment, "start"), offset_ms),
                    e=_ms(_val(segment, "end"), offset_ms),
                    t=text,
                )
            )
    return tuple(words)


def _prepare_cleaned_audio(audio_uri: str) -> tuple[str, bool]:
    """Apply FFmpeg noise reduction and loudness normalization to the audio before ASR.

    Returns (effective_path, is_temporary).
    """
    if not os.path.exists(audio_uri):
        return audio_uri, False
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return audio_uri, False
    try:
        fd, clean_path = tempfile.mkstemp(suffix="_clean.wav")
        os.close(fd)
        filter_str = "highpass=f=80,lowpass=f=8500,afftdn=nf=-25:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11"
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            audio_uri,
            "-af",
            filter_str,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            clean_path,
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
        if proc.returncode == 0 and os.path.exists(clean_path) and os.path.getsize(clean_path) > 0:
            return clean_path, True
        if os.path.exists(clean_path):
            os.remove(clean_path)
    except Exception as e:
        _log.warning("ffmpeg audio pre-clean skipped: %s", e)
    return audio_uri, False


def _build_initial_prompt(hints: tuple[str, ...] | list[str] | None) -> str | None:
    """Whisper's only hotword mechanism is the decoder prompt (`09 §3`).

    Every term comes from the caller's glossary/hints (B09/B09b) — never
    hardcoded here. A domain vocabulary belongs in the workspace's glossary,
    not baked into a shared provider adapter that every workspace calls.
    """
    hint_list = [h.strip() for h in (hints or ()) if h.strip()]
    if hint_list:
        return ", ".join(hint_list)
    return None


def _ensure_cuda_libraries_on_path() -> None:
    """Windows only: put pip-installed NVIDIA runtime DLLs where CTranslate2 finds them.

    ``pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`` places
    ``cublas64_12.dll``/``cudnn64_9.dll`` under each package's own ``bin/``
    directory, but CTranslate2's compiled extension resolves them with a plain
    Windows ``LoadLibrary`` call, which only sees ``PATH`` — not
    ``os.add_dll_directory()``, which affects Python's own import machinery,
    not a load a native extension issues internally. A no-op when the packages
    are absent (CPU-only boxes, containers, CI): the CUDA device count probe
    right after this simply comes back 0 and :func:`_resolve_device` falls
    back to CPU, same as if this function had never run.
    """
    if os.name != "nt":
        return
    from importlib.util import find_spec

    found: list[str] = []
    for package in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
        spec = find_spec(package)
        if spec is None or not spec.submodule_search_locations:
            continue
        for location in spec.submodule_search_locations:
            candidate = os.path.join(location, "bin")
            if os.path.isdir(candidate) and candidate not in found:
                found.append(candidate)
    if not found:
        return
    current = os.environ.get("PATH", "")
    missing = [path for path in found if path not in current]
    if missing:
        os.environ["PATH"] = os.pathsep.join((*missing, current))


def _resolve_device(requested: str) -> str:
    """``cpu``/``cuda`` as asked, or a real probe when ``auto`` — never raises.

    A GPU library that is missing, mismatched or driverless must degrade to
    CPU rather than fail the job: the same "always answer" rule as
    :class:`~worker_ai.lid.IndicLidClassifier`.
    """
    wanted = (requested or "auto").strip().lower()
    if wanted in ("cpu", "cuda"):
        if wanted == "cuda":
            _ensure_cuda_libraries_on_path()
        return wanted
    try:
        _ensure_cuda_libraries_on_path()
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception as error:  # pragma: no cover - depends on the optional extra
        _log.debug("cuda probe failed; using cpu", extra={"reason": str(error)[:200]})
    return "cpu"


def _resolve_compute_type(requested: str, device: str) -> str:
    """A quantisation the resolved device can actually run, unless one was asked for."""
    if requested:
        return requested
    return "int8_float16" if device == "cuda" else "int8"


class LocalWhisperProvider(Provider):
    """Local Whisper provider: runs official openai-whisper (default) or faster-whisper off the event loop."""

    name = "local-whisper"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        word_timestamps=True,
        diarisation=False,
        max_duration_s=None,
        batch=False,
        languages=(),
    )

    #: Self-hosted compute, not a per-minute vendor price (`05 §12` counts it under
    #: the serverless GPU line); a local run costs the developer's own machine.
    cost_per_minute_inr = 0.0

    def __init__(
        self,
        *,
        model_name: str = "large-v3",
        device: str = "auto",
        compute_type: str = "",
        beam_size: int = 5,
        engine: str = "faster-whisper",
        model_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.model_name = model_name
        #: As configured — possibly ``"auto"``; use ``_resolved_device`` once
        #: ``_build()`` has run, never this, for a device comparison.
        self.device = device
        #: As configured — possibly ``""`` (device-appropriate default).
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.engine = engine
        self._model_factory = model_factory
        self._model: Any = None
        self._resolved_device: str | None = None
        self._lock = asyncio.Lock()

    async def _load(self) -> Any:
        """Load once, under a lock: two concurrent chunks must not both download."""
        async with self._lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._build)
            return self._model

    def _build(self) -> Any:
        resolved_device = _resolve_device(self.device)
        self._resolved_device = resolved_device
        if self._model_factory is not None:
            return self._model_factory()
        if self.engine in ("openai-whisper", "whisper"):
            try:
                import whisper
            except ImportError as error:
                raise ProviderError(
                    'openai-whisper is not installed; run pip install openai-whisper',
                    provider=self.name,
                    retryable=False,
                ) from error
            _log.info(
                "loading openai-whisper",
                extra={"model": self.model_name, "device": resolved_device},
            )
            return whisper.load_model(self.model_name, device=resolved_device)
        else:
            try:
                from faster_whisper import WhisperModel as FasterWhisperModel
            except ImportError as error:
                raise ProviderError(
                    'faster-whisper is not installed; run pip install -e ".[local-asr]"',
                    provider=self.name,
                    retryable=False,
                ) from error
            resolved_compute = _resolve_compute_type(self.compute_type, resolved_device)
            _log.info(
                "loading faster-whisper",
                extra={
                    "model": self.model_name,
                    "device": resolved_device,
                    "computeType": resolved_compute,
                },
            )
            return FasterWhisperModel(
                self.model_name, device=resolved_device, compute_type=resolved_compute
            )

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        model = await self._load()
        audio_path, is_temp = await asyncio.to_thread(_prepare_cleaned_audio, request.audio_uri)
        try:
            req_lang = request.language
            whisper_lang = "hi" if req_lang and req_lang.lower().startswith("hi") else req_lang
            prompt = _build_initial_prompt(request.hints)

            if self.engine in ("openai-whisper", "whisper"):
                effective_beam = 1 if self._resolved_device == "cpu" else self.beam_size
                options: dict[str, Any] = {
                    "beam_size": effective_beam,
                    "word_timestamps": request.word_timestamps,
                    **request.options,
                }
                if whisper_lang:
                    options["language"] = whisper_lang
                if prompt:
                    options["initial_prompt"] = prompt

                try:
                    result_dict = await asyncio.to_thread(model.transcribe, audio_path, **options)
                    segments = result_dict.get("segments", [])
                    words = await asyncio.to_thread(words_from_segments, segments, request.offset_ms)
                except ProviderError:
                    raise
                except Exception as error:
                    raise ProviderError(
                        f"openai-whisper failed: {error}", provider=self.name, retryable=True
                    ) from error

                language = str(result_dict.get("language") or request.language or "en")
                duration = max((_val(seg, "end", 0.0) for seg in segments), default=0.0)
                return TranscriptionResult(
                    words=words,
                    language=language,
                    language_confidence=1.0,
                    usage=ProviderUsage(
                        media_seconds=float(duration),
                        provider=self.name,
                        model=self.model_name,
                        cost_minor=0,
                    ),
                    submissions=(
                        ProviderSubmission(
                            provider=self.name,
                            endpoint="local://openai-whisper",
                            artefact=request.audio_uri,
                            retention_class="none",
                        ),
                    ),
                    raw={"model": self.model_name, "device": self.device, "engine": self.engine},
                )
            else:
                options = {
                    "beam_size": self.beam_size,
                    "word_timestamps": request.word_timestamps,
                    "vad_filter": False,  # the worker has already run VAD (D14)
                    **request.options,
                }
                if whisper_lang:
                    options["language"] = whisper_lang
                if prompt:
                    # Whisper's only hotword mechanism is the decoder prompt (`09 §3`).
                    options["initial_prompt"] = prompt

                try:
                    segments, info = await asyncio.to_thread(model.transcribe, audio_path, **options)
                    words = await asyncio.to_thread(words_from_segments, segments, request.offset_ms)
                except ProviderError:
                    raise
                except Exception as error:
                    raise ProviderError(
                        f"faster-whisper failed: {error}", provider=self.name, retryable=True
                    ) from error

                language = str(getattr(info, "language", "") or request.language or "en")
                probability = getattr(info, "language_probability", None)
                seconds = float(getattr(info, "duration", 0.0) or 0.0)
                return TranscriptionResult(
                    words=words,
                    language=language,
                    language_confidence=(round(float(probability), 4) if probability is not None else None),
                    usage=ProviderUsage(
                        media_seconds=seconds,
                        provider=self.name,
                        model=self.model_name,
                        cost_minor=0,
                    ),
                    submissions=(
                        # Local inference: nothing leaves the machine, but the row still
                        # exists so an erasure sweep sees a complete picture of the job.
                        ProviderSubmission(
                            provider=self.name,
                            endpoint="local://faster-whisper",
                            artefact=request.audio_uri,
                            retention_class="none",
                        ),
                    ),
                    raw={"model": self.model_name, "device": self.device, "engine": self.engine},
                )
        finally:
            if is_temp and os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                except OSError:
                    pass

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("local-whisper does not do forced alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("local-whisper does not diarise")
