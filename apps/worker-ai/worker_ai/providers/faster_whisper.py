"""High-Accuracy Faster-Whisper Large v3 Provider Daemon (Pillar 4 / Feature 02).

Optimized for:
1. Warm resident WhisperModel("large-v3", device="cuda", compute_type="float16") in memory,
   eliminating cold-start latency across job executions.
2. Enforced decode parameters: beam_size=5, vad_filter=True, and condition_on_previous_text=False
   to prevent hallucination looping across silence gaps.
3. Word-level timestamp generation and hallucination loop filtering.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from worker_ai.highlights.text import filter_hallucination_loops
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import (
    ProviderCapabilities,
    TranscriptionRequest,
    TranscriptionResult,
)
from worker_ai.providers.local_whisper import (
    LocalWhisperProvider,
    _resolve_compute_type,
    _resolve_device,
)

__all__ = [
    "FasterWhisperProvider",
    "clear_warm_models",
    "get_warm_whisper_model",
    "warm_model",
]

_log = get_logger(__name__)

#: Resident model instances kept warm in GPU/CPU memory to avoid cold starts.
_WARM_MODELS: dict[tuple[str, str, str], Any] = {}
_WARM_LOCK = asyncio.Lock()


def get_warm_whisper_model(
    model_name: str = "large-v3",
    device: str = "cuda",
    compute_type: str = "float16",
    *,
    model_factory: Callable[..., Any] | None = None,
) -> Any:
    """Retrieve or initialize a warm resident WhisperModel instance."""
    resolved_dev = _resolve_device(device)
    resolved_compute = _resolve_compute_type(compute_type, resolved_dev)
    cache_key = (model_name, resolved_dev, resolved_compute)

    if cache_key in _WARM_MODELS:
        return _WARM_MODELS[cache_key]

    if model_factory is not None:
        model = model_factory(model_name)
    else:
        try:
            from faster_whisper import WhisperModel
        except ImportError as err:
            raise RuntimeError(
                'faster-whisper is not installed; install with pip install -e ".[local-asr]"'
            ) from err

        _log.info(
            "warming faster-whisper model into memory",
            extra={"model": model_name, "device": resolved_dev, "computeType": resolved_compute},
        )
        model = WhisperModel(model_name, device=resolved_dev, compute_type=resolved_compute)

    _WARM_MODELS[cache_key] = model
    return model


async def warm_model(
    model_name: str = "large-v3",
    device: str = "cuda",
    compute_type: str = "float16",
    *,
    model_factory: Callable[..., Any] | None = None,
) -> Any:
    """Asynchronously warm the WhisperModel into resident memory."""
    async with _WARM_LOCK:
        return await asyncio.to_thread(
            get_warm_whisper_model,
            model_name=model_name,
            device=device,
            compute_type=compute_type,
            model_factory=model_factory,
        )


def clear_warm_models() -> None:
    """Clear resident cached models (useful for testing and memory release)."""
    _WARM_MODELS.clear()


class FasterWhisperProvider(LocalWhisperProvider):
    """Faster-Whisper Large v3 daemon provider with warm memory residence.

    Enforces:
    - beam_size=5 for maximum accuracy
    - vad_filter=True for voice activity isolation
    - condition_on_previous_text=False to completely prevent hallucination looping
    """

    name = "faster-whisper"

    capabilities = ProviderCapabilities(
        supported=frozenset({"transcribe"}),
        word_timestamps=True,
        diarisation=False,
        max_duration_s=None,
        batch=False,
        languages=(),
    )

    cost_per_minute_inr = 0.0

    def __init__(
        self,
        *,
        model_name: str = "large-v3",
        english_model_name: str = "",
        device: str = "cuda",
        compute_type: str = "float16",
        beam_size: int = 5,
        engine: str = "faster-whisper",
        model_factory: Callable[..., Any] | None = None,
    ) -> None:
        super().__init__(
            model_name=model_name,
            english_model_name=english_model_name,
            device=device,
            compute_type=compute_type,
            beam_size=beam_size,
            engine=engine,
            model_factory=model_factory,
        )
        self.vad_filter = True
        self.condition_on_previous_text = False

    def _build(self, weights: str) -> Any:
        """Retrieve model from warm cache or build and warm."""
        resolved_device = _resolve_device(self.device)
        self._devices[weights] = resolved_device
        if self._model_factory is not None:
            return get_warm_whisper_model(
                model_name=weights,
                device=resolved_device,
                compute_type=self.compute_type,
                model_factory=self._model_factory,
            )
        resolved_compute = _resolve_compute_type(self.compute_type, resolved_device)
        return get_warm_whisper_model(
            model_name=weights,
            device=resolved_device,
            compute_type=resolved_compute,
        )

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        """Transcribe audio with warm model.

        Enforces beam_size=5, vad_filter=True, condition_on_previous_text=False.
        """
        # Ensure our target parameters are present in options
        enforced_options = dict(request.options)
        if "beam_size" not in enforced_options:
            enforced_options["beam_size"] = self.beam_size
        if "vad_filter" not in enforced_options:
            enforced_options["vad_filter"] = self.vad_filter
        if "condition_on_previous_text" not in enforced_options:
            enforced_options["condition_on_previous_text"] = self.condition_on_previous_text

        updated_request = TranscriptionRequest(
            audio_uri=request.audio_uri,
            language=request.language,
            word_timestamps=request.word_timestamps,
            hints=request.hints,
            offset_ms=request.offset_ms,
            options=enforced_options,
        )

        result = await super().transcribe(updated_request)

        # Apply hallucination loop and punctuation filter on the returned words
        filtered_words = filter_hallucination_loops(result.words, max_repeats=3)

        return TranscriptionResult(
            words=tuple(filtered_words),
            language=result.language,
            language_confidence=result.language_confidence,
            usage=result.usage,
            segments=result.segments,
            submissions=result.submissions,
            raw={
                **result.raw,
                "warm": True,
                "beamSize": enforced_options.get("beam_size", self.beam_size),
                "vadFilter": enforced_options.get("vad_filter", self.vad_filter),
                "conditionOnPreviousText": enforced_options.get(
                    "condition_on_previous_text", self.condition_on_previous_text
                ),
            },
        )
