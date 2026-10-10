"""faster-whisper on the CPU: the local lane and the offline fallback.

`09 §1` routes global languages to a self-hosted ``large-v3-turbo`` on serverless
GPU. This adapter is the same model family run in-process, which is what makes a
developer machine, a CI box and the eval harness able to produce a real transcript
with no vendor account at all.

``faster-whisper`` is an **optional** dependency (``pip install -e ".[local-asr]"``,
and the CPU Docker image installs it): it drags in CTranslate2 and downloads model
weights on first use, neither of which belongs in the unit-test path. The import
therefore happens inside :meth:`LocalWhisperProvider._build`, and the adapter is
still fully testable because the model factory is injectable.

**Two sets of weights, one adapter.** The default weights
(``WORKER_AI_WHISPER_MODEL``) are a Hindi/Hinglish fine-tune on this deployment,
and on English speech they write "1 more" and "built built built"; they also
report *every* language as English (each local-whisper probe since the fine-tune
went live on 2026-09-12 said ``en`` at 1.0, Hinglish audio included), so they
cannot be what "detect the language" runs on. ``WORKER_AI_WHISPER_MODEL_EN``
adds a general model for the lanes ``routing.yaml`` points at it. Each is loaded
the first time a request needs it and then stays resident — both fit on the 6 GB
card, and reloading per job would cost more than the job.

**The English weights are optional at every step.** Unset, unusable at boot
(:func:`weights_problem`, checked by the registry) or failing to load, English is
served by the default weights — the behaviour before they existed — and the
result says so (``raw["family"]``), because the default weights' language
detection must then not be trusted. The default weights always load first, so
if the card cannot hold both it is English, which has somewhere to go, that is
left out. Nothing is ever moved to the CPU behind the operator's back.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Final, Protocol

from worker_ai.highlights.text import filter_hallucination_loops, sanitize_transcript_text
from worker_ai.languages import whisper_language
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

__all__ = [
    "DEFAULT_FAMILY",
    "DEFAULT_RETRY_AFTER_S",
    "DEFAULT_ROUTING_MODELS",
    "ENGLISH_FAMILY",
    "ENGLISH_RETRY_AFTER_S",
    "ENGLISH_ROUTING_MODELS",
    "LocalWhisperProvider",
    "WhisperModel",
    "weights_label",
    "weights_problem",
    "words_from_segments",
]

_log = get_logger(__name__)

#: The deployment's default weights (``WORKER_AI_WHISPER_MODEL``).
DEFAULT_FAMILY = "default"
#: The general weights for English (``WORKER_AI_WHISPER_MODEL_EN``).
ENGLISH_FAMILY = "en"

#: What ``routing.yaml`` calls the general weights in a ``local-whisper``
#: candidate's ``model``. The table picks the weights, not the request's
#: language, because the first chunk of an "auto" job is sent with no language
#: at all (it is the LID probe) and must still run on the weights of the lane
#: it was routed to — see :meth:`LocalWhisperProvider.family_for`.
ENGLISH_ROUTING_MODELS: frozenset[str] = frozenset({"large-v3-turbo"})
#: What the table calls the default weights. Any name outside both sets also
#: selects the default, which is how every lane behaved before the table's
#: ``model`` was honoured; ``test_whisper_models.py`` fails on such a name so a
#: typo cannot quietly put English back on the fine-tune.
DEFAULT_ROUTING_MODELS: frozenset[str] = frozenset({"whisper-hindi2hinglish-apex"})

#: Routing knobs that travel in ``request.options`` (see
#: ``RoutingCandidate.provider_options``) but are not decode options: handing
#: one to ``transcribe(**options)`` is a TypeError on every chunk.
_ROUTING_OPTION_KEYS = frozenset({"model", "mode", "api"})

#: How long weights that failed to load are left alone before a request tries
#: them again. The English weights have somewhere to go meanwhile (the default
#: weights serve English), so they wait ten minutes rather than re-read 1.6 GB
#: for every chunk of every English job. The default weights have nowhere to go,
#: so they wait only long enough for one job's parallel chunks to share a single
#: failure — under the ``ai`` queues' 15 s retry backoff (``jobs.config.ts``),
#: so BullMQ's retry still makes a real attempt.
ENGLISH_RETRY_AFTER_S = 600.0
DEFAULT_RETRY_AFTER_S = 10.0

#: What makes a value that is not on disk a path rather than a model name. A
#: Hugging Face repo id has exactly one forward slash, so one slash is a name.
_PATH_SHAPED = re.compile(r"^(?:[A-Za-z]:|[/\\~.])|\\|/.*/|\.(?:pt|bin)$")


def weights_label(weights: str) -> str:
    """The last component of a weights path (or a model name as it is).

    What errors, logs and ``engineVersions`` carry: enough to tell the two sets
    of weights apart, without a user's home directory in a job's error row.
    """
    parts = [part for part in re.split(r"[\\/]", weights.strip()) if part]
    return parts[-1] if parts else weights


def weights_problem(value: str, *, engine: str = "faster-whisper") -> str | None:
    """Why ``value`` cannot be loaded as Whisper weights, or ``None`` when it may be.

    Anything that exists on disk is a path, whatever its spelling. It must be
    the shape its engine loads: a CTranslate2 directory (with ``model.bin``) for
    faster-whisper, a checkpoint file for openai-whisper. A value that is not
    on disk is a model name — a size such as ``large-v3`` or a Hugging Face repo
    id, fetched on first use — unless it is shaped like a path (absolute,
    drive-lettered, dot- or tilde-relative, backslashed, two slashes deep, or a
    weights file name), which is a path that is missing.
    """
    if not value:
        return None
    path = Path(value).expanduser()
    if path.exists():
        if engine in ("openai-whisper", "whisper"):
            if path.is_file():
                return None
            return "openai-whisper loads a checkpoint file, and this is a directory"
        if not path.is_dir():
            return "faster-whisper loads a CTranslate2 model directory, and this is a file"
        if not (path / "model.bin").is_file():
            return "the directory has no model.bin, so it is not a CTranslate2 model"
        return None
    if _PATH_SHAPED.search(value.strip()):
        return "nothing exists at that path"
    return None


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
                raw_text = str(_val(word, "word", "")).strip()
                if not raw_text:
                    continue
                text = sanitize_transcript_text(raw_text)
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
        raw_text = str(_val(segment, "text", "")).strip()
        if raw_text:
            text = sanitize_transcript_text(raw_text)
            if text:
                words.append(
                    Word(
                        s=_ms(_val(segment, "start"), offset_ms),
                        e=_ms(_val(segment, "end"), offset_ms),
                        t=text,
                    )
                )
    return tuple(filter_hallucination_loops(words))


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
        proc = subprocess.run(  # noqa: S603
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


DEFAULT_AI_FRONTIER_HOTWORDS: Final[tuple[str, ...]] = (
    "GPT-6.1 Sol",
    "Claude Sonnet 5.5",
    "Claude Opus 5.5",
    "Gemini 4 Argon",
    "Ideogram 4.5",
    "Flux 3",
    "ElevenLabs",
    "Unitree G1",
    "Tsinghua",
)


def _build_initial_prompt(hints: tuple[str, ...] | list[str] | None) -> str | None:
    """Whisper's only hotword mechanism is the decoder prompt (`09 §3`).

    No hardcoded vocabulary: every term comes from the glossary/hints (B09).
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


def _call_factory(factory: Callable[..., Any], weights: str) -> Any:
    """Call an injected model factory, telling it the weights when it asks.

    Most tests pass a zero-argument factory (one fake for every family); a test
    that cares which weights were loaded passes one that takes them.
    """
    try:
        parameters = inspect.signature(factory).parameters.values()
    except (TypeError, ValueError):
        return factory()
    positional = [
        parameter
        for parameter in parameters
        if parameter.kind
        in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    return factory(weights) if positional else factory()


class LocalWhisperProvider(Provider):
    """Local Whisper provider: runs official openai-whisper or faster-whisper off the loop."""

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
        english_model_name: str = "",
        device: str = "auto",
        compute_type: str = "",
        beam_size: int = 5,
        engine: str = "faster-whisper",
        model_factory: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.model_name = model_name
        #: Empty means :attr:`model_name` serves English too.
        self.english_model_name = english_model_name
        #: As configured — possibly ``"auto"``; use ``_devices`` once ``_build()``
        #: has run, never this, for a device comparison.
        self.device = device
        #: As configured — possibly ``""`` (device-appropriate default).
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.engine = engine
        self._model_factory = model_factory
        self._clock = clock
        #: Loaded models by weights, so two families naming the same weights
        #: share one load.
        self._models: dict[str, Any] = {}
        #: The device each loaded model actually landed on.
        self._devices: dict[str, str] = {}
        #: Weights whose last load failed: when, and the error to repeat until
        #: their retry interval has passed.
        self._failures: dict[str, tuple[float, ProviderError]] = {}
        self._lock = asyncio.Lock()

    def family_for(self, *, language: str | None = None, routed_model: str | None = None) -> str:
        """Which weights serve a request: the routing table's choice, else the language's.

        Inside ``ai.transcribe`` the table decides (the candidate's ``model``,
        passed as ``options["model"]``). It has to: an "auto" job's first chunk
        is sent with no language because it *is* the language probe, and when
        LID keeps the lane that chunk is kept — so it must already have run on
        the lane's weights, or the first ten minutes of an English job would
        come from the Hindi fine-tune. Outside the pipeline (the eval CLI, a
        direct call) the request's language decides: English gets the English
        weights, everything else the default.
        """
        if routed_model:
            return ENGLISH_FAMILY if routed_model in ENGLISH_ROUTING_MODELS else DEFAULT_FAMILY
        return ENGLISH_FAMILY if whisper_language(language) == "en" else DEFAULT_FAMILY

    def weights_for(self, *, language: str | None = None, routed_model: str | None = None) -> str:
        """The weights (a size name or a CTranslate2 directory) a request runs on.

        Also the cache's idea of "which model", so a transcript made while the
        English weights were unset — or were failing to load, and English ran on
        the default weights — is never served back as theirs.
        """
        family = self.family_for(language=language, routed_model=routed_model)
        english = self._english_weights()
        if family == ENGLISH_FAMILY and english and self._recent_failure(english) is None:
            return english
        return self.model_name

    def _english_weights(self) -> str:
        """The English weights when they are a second set, else ``""``."""
        if self.english_model_name and self.english_model_name != self.model_name:
            return self.english_model_name
        return ""

    def _recent_failure(self, weights: str) -> ProviderError | None:
        """The error of a load that failed within its retry interval, if any."""
        failure = self._failures.get(weights)
        if failure is None:
            return None
        failed_at, error = failure
        wait = (
            ENGLISH_RETRY_AFTER_S if weights == self._english_weights() else DEFAULT_RETRY_AFTER_S
        )
        if self._clock() - failed_at >= wait:
            return None
        return error

    async def _resolve(self, requested: str) -> tuple[str, str, Any]:
        """``(family that serves, its weights, the loaded model)`` for a family.

        English is served by the English weights when they are a second set and
        load; otherwise — unset, failing, or waiting out a failure — by the
        default weights, which is exactly how English ran before they existed.
        The default weights are loaded first either way: when the card cannot
        hold both, the one left out must be English, which can fall back, and
        not the Hinglish fine-tune, which cannot.
        """
        english = self._english_weights()
        if requested == ENGLISH_FAMILY and english:
            if self.model_name not in self._models:
                # A default that will not load is that family's error to report
                # (`_load` logs it); English can still try its own weights.
                with contextlib.suppress(ProviderError):
                    await self._load(self.model_name)
            try:
                return ENGLISH_FAMILY, english, await self._load(english)
            except ProviderError:
                pass  # logged by `_load`, with what happens next
        return DEFAULT_FAMILY, self.model_name, await self._load(self.model_name)

    async def _load(self, weights: str) -> Any:
        """Load each set of weights once and keep it: never a reload per job.

        One lock for every load, so two concurrent chunks never both download,
        two models never initialise on the GPU at once, and two 1.6 GB files are
        never read into host memory together; a model that is already resident
        is returned without waiting on someone else's load. A failed load is
        remembered for its retry interval, so the chunks after it fail (or, for
        English, fall back) at once instead of each re-reading the weights.
        """
        model = self._models.get(weights)
        if model is not None:
            return model
        async with self._lock:
            model = self._models.get(weights)
            if model is not None:
                return model
            remembered = self._recent_failure(weights)
            if remembered is not None:
                raise remembered
            try:
                model = await asyncio.to_thread(self._build, weights)
            except Exception as error:
                # A ProviderError lets the routing chain try its next candidate;
                # a bare exception would skip the chain entirely.
                failure = (
                    error
                    if isinstance(error, ProviderError)
                    else ProviderError(
                        "could not load the Whisper model "
                        + weights_label(weights)
                        + ": "
                        + str(error)[:300],
                        provider=self.name,
                        retryable=True,
                    )
                )
                self._failures[weights] = (self._clock(), failure)
                english = weights == self._english_weights()
                _log.error(
                    "Whisper weights failed to load",
                    extra={
                        "weights": weights_label(weights),
                        "family": ENGLISH_FAMILY if english else DEFAULT_FAMILY,
                        "reason": str(error)[:300],
                        "retryAfterS": (
                            ENGLISH_RETRY_AFTER_S if english else DEFAULT_RETRY_AFTER_S
                        ),
                        "meanwhile": (
                            "English is transcribed on WORKER_AI_WHISPER_MODEL"
                            if english
                            else "local-whisper requests on these weights fail"
                        ),
                    },
                )
                if failure is error:
                    raise
                raise failure from error
            self._failures.pop(weights, None)
            self._models[weights] = model
            return model

    def _build(self, weights: str) -> Any:
        resolved_device = _resolve_device(self.device)
        self._devices[weights] = resolved_device
        if self._model_factory is not None:
            return _call_factory(self._model_factory, weights)
        if self.engine in ("openai-whisper", "whisper"):
            try:
                import whisper
            except ImportError as error:
                raise ProviderError(
                    "openai-whisper is not installed; run pip install openai-whisper",
                    provider=self.name,
                    retryable=False,
                ) from error
            _log.info(
                "loading openai-whisper",
                extra={"model": weights, "device": resolved_device},
            )
            return whisper.load_model(weights, device=resolved_device)
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
            extra={"model": weights, "device": resolved_device, "computeType": resolved_compute},
        )
        # A load that fails on the GPU fails; it is never retried on the CPU.
        # Here that would run a 1.5B-parameter model at beam 5 on the laptop
        # that also serves the API, web, Postgres, Redis and MinIO — for hours
        # on a long video, paging RAM, while the heartbeat kept the job alive
        # and nothing said so. English falls back to the default weights
        # instead (`_resolve`), and a default that will not load is an error the
        # routing chain and BullMQ handle. No GPU at all is a different case:
        # `_resolve_device` sends `auto` to the CPU before anything loads.
        return FasterWhisperModel(weights, device=resolved_device, compute_type=resolved_compute)

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        routed_model = str(request.options.get("model") or "") or None
        requested = self.family_for(language=request.language, routed_model=routed_model)
        family, weights, model = await self._resolve(requested)
        device = self._devices.get(weights, self.device)
        decode_options = {
            key: value for key, value in request.options.items() if key not in _ROUTING_OPTION_KEYS
        }
        # `family` is what actually ran: `en` only when the general weights did.
        # The pipeline trusts this result's language detection on that alone.
        raw = {
            "model": weights,
            "family": family,
            "requestedFamily": requested,
            "device": device,
            "engine": self.engine,
        }
        audio_path, is_temp = await asyncio.to_thread(_prepare_cleaned_audio, request.audio_uri)
        try:
            # A bare code Whisper accepts (`en-IN` -> `en`, `hi-Latn` -> `hi`), or
            # None to let it detect: a region or script tag fails every chunk.
            whisper_lang = whisper_language(request.language)
            prompt = _build_initial_prompt(request.hints)

            if self.engine in ("openai-whisper", "whisper"):
                effective_beam = 1 if device == "cpu" else self.beam_size
                options: dict[str, Any] = {
                    "beam_size": effective_beam,
                    "word_timestamps": request.word_timestamps,
                    **decode_options,
                }
                if whisper_lang:
                    options["language"] = whisper_lang
                if prompt:
                    options["initial_prompt"] = prompt

                try:
                    result_dict = await asyncio.to_thread(model.transcribe, audio_path, **options)
                    segments = result_dict.get("segments", [])
                    words = await asyncio.to_thread(
                        words_from_segments, segments, request.offset_ms
                    )
                except ProviderError:
                    raise
                except (ValueError, TypeError) as error:
                    raise _refused("openai-whisper", error) from error
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
                        model=weights,
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
                    raw=raw,
                )
            else:
                options = {
                    "beam_size": self.beam_size,
                    "word_timestamps": request.word_timestamps,
                    "vad_filter": False,  # the worker has already run VAD (D14)
                    "condition_on_previous_text": False,
                    "suppress_tokens": [-1],
                    **decode_options,
                }
                if whisper_lang:
                    options["language"] = whisper_lang
                if prompt:
                    # Whisper's only hotword mechanism is the decoder prompt (`09 §3`).
                    options["initial_prompt"] = prompt

                try:
                    segments, info = await asyncio.to_thread(
                        model.transcribe, audio_path, **options
                    )
                    words = await asyncio.to_thread(
                        words_from_segments, segments, request.offset_ms
                    )
                except ProviderError:
                    raise
                except (ValueError, TypeError) as error:
                    raise _refused("faster-whisper", error) from error
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
                    language_confidence=(
                        round(float(probability), 4) if probability is not None else None
                    ),
                    usage=ProviderUsage(
                        media_seconds=seconds,
                        provider=self.name,
                        model=weights,
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
                    raw=raw,
                )
        finally:
            if is_temp:
                with contextlib.suppress(OSError):
                    os.remove(audio_path)

    async def align(self, request: AlignmentRequest) -> TranscriptionResult:
        raise NotImplementedError("local-whisper does not do forced alignment")

    async def diarise(self, request: DiarisationRequest) -> tuple[DiarisedSpeaker, ...]:
        raise NotImplementedError("local-whisper does not diarise")


def _refused(engine: str, error: Exception) -> ProviderError:
    """A request the model rejected outright: never retried, because it cannot change.

    A ValueError or TypeError from ``transcribe`` is about the request itself —
    2026-09-27's "'en-IN' is not a valid language code" is the case that
    mattered — and the same audio and options fail the same way on every
    attempt. Marking it retryable spent BullMQ's retries repeating it and hid
    the cause behind a dead-letter row. The routing chain still moves on to its
    next candidate either way.
    """
    return ProviderError(
        engine + " refused the request: " + str(error)[:300],
        provider=LocalWhisperProvider.name,
        retryable=False,
    )
