"""Segment-preserving translation with provider fallback (`09 §4`, A22).

Orchestrates, in order:

1. **Glossary masking** (`glossary.py`) — every segment, before any provider
   sees it.
2. **Provider chain** — Sarvam Mayura, then IndicTrans2 (when configured), then
   the LLM adapter; the first that does not raise wins the whole batch (a
   partial success is not attempted — mixing providers mid-transcript would mix
   voice and glossary compliance, worse than falling through cleanly).
3. **Glossary unmasking** on the winning provider's output.
4. **Length-aware retry** (`length.py`): segments over the 1.3x budget go back
   to the *same* provider once with `shorter=True`; anything still over budget
   after that is hard-truncated, so the budget holds unconditionally.

All of it against the same request/response contract every provider
implements, so the chain is "call the next one" and nothing more.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import ProviderError, ProviderSubmission
from worker_ai.translate.glossary import GlossaryMasked, mask_glossary_terms, unmask_glossary_terms
from worker_ai.translate.length import exceeds_budget, truncate_to_budget
from worker_ai.translate.providers.base import (
    TranslatedSegment,
    TranslationProvider,
    TranslationRequest,
    TranslationSegment,
)

__all__ = [
    "MAX_LENGTH_RETRIES",
    "AllProvidersFailedError",
    "TranslateSegmentsResult",
    "TranslatedSegmentOut",
    "translate_segments",
]

_log = get_logger(__name__)

#: How many "shorter, please" round trips a segment gets before it is truncated.
MAX_LENGTH_RETRIES = 2


class AllProvidersFailedError(RuntimeError):
    """Every provider in the chain raised. Carries the last error's message."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class TranslatedSegmentOut:
    segment_id: str
    text: str
    #: True when the 1.3x budget still could not be met by retrying and the text
    #: was hard-truncated — reported so the job event can flag it for review.
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class TranslateSegmentsResult:
    segments: tuple[TranslatedSegmentOut, ...]
    #: Which provider in the chain produced the result.
    provider: str
    submissions: tuple[ProviderSubmission, ...] = field(default_factory=tuple)
    length_retries: int = 0
    truncated: int = 0


async def translate_segments(
    providers: tuple[TranslationProvider, ...],
    *,
    segments: tuple[tuple[str, str], ...],
    source_language: str,
    target_language: str,
    glossary: tuple[str, ...] = (),
) -> TranslateSegmentsResult:
    """Translate `segments` (`(segmentId, text)`, document order) end to end.

    :raises AllProvidersFailedError: when every provider in `providers` raised.
    :raises ValueError: when `providers` is empty, or a provider returned a
        segment count that does not match the request — a contract violation,
        not a transient failure.
    """
    if not providers:
        raise ValueError("translate_segments needs at least one provider")
    if not segments:
        return TranslateSegmentsResult(segments=(), provider=providers[0].name)

    masks = {segment_id: mask_glossary_terms(text, glossary) for segment_id, text in segments}
    sources = dict(segments)

    provider, raw = await _run_chain(providers, masks, sources, source_language, target_language)

    unmasked = {
        segment_id: unmask_glossary_terms(text, masks[segment_id].terms)
        for segment_id, text in raw.items()
    }

    current = unmasked
    retries = 0
    for _attempt in range(MAX_LENGTH_RETRIES):
        over_budget = [
            segment_id
            for segment_id, text in current.items()
            if exceeds_budget(sources[segment_id], text)
        ]
        if not over_budget:
            break
        retries += 1
        retry_request = TranslationRequest(
            segments=tuple(
                TranslationSegment(
                    segment_id=segment_id, text=masks[segment_id].text, shorter=True
                )
                for segment_id in over_budget
            ),
            source_language=source_language,
            target_language=target_language,
        )
        try:
            retry_result = await provider.translate(retry_request)
        except ProviderError:
            # The winning provider is now failing on a retry; stop retrying and
            # let the final truncation pass enforce the budget instead of
            # cascading into the rest of the chain mid-batch.
            break
        _assert_same_segments(retry_request.segments, retry_result.segments)
        for translated in retry_result.segments:
            current[translated.segment_id] = unmask_glossary_terms(
                translated.text, masks[translated.segment_id].terms
            )

    truncated_count = 0
    out: list[TranslatedSegmentOut] = []
    for segment_id, _source_text in segments:
        text = current[segment_id]
        source_text = sources[segment_id]
        was_truncated = exceeds_budget(source_text, text)
        if was_truncated:
            text = truncate_to_budget(source_text, text)
            truncated_count += 1
        out.append(TranslatedSegmentOut(segment_id=segment_id, text=text, truncated=was_truncated))

    return TranslateSegmentsResult(
        segments=tuple(out),
        provider=provider.name,
        length_retries=retries,
        truncated=truncated_count,
    )


async def _run_chain(
    providers: tuple[TranslationProvider, ...],
    masks: dict[str, GlossaryMasked],
    sources: dict[str, str],
    source_language: str,
    target_language: str,
) -> tuple[TranslationProvider, dict[str, str]]:
    """Try each provider in order; the first success wins the whole batch."""
    request = TranslationRequest(
        segments=tuple(
            TranslationSegment(segment_id=segment_id, text=masks[segment_id].text)
            for segment_id in sources
        ),
        source_language=source_language,
        target_language=target_language,
    )

    last_error: ProviderError | None = None
    for candidate in providers:
        try:
            result = await candidate.translate(request)
        except ProviderError as error:
            last_error = error
            _log.warning(
                "translation provider failed; trying the next one",
                extra={"provider": candidate.name, "reason": str(error)[:200]},
            )
            continue
        _assert_same_segments(request.segments, result.segments)
        return candidate, {segment.segment_id: segment.text for segment in result.segments}

    message = str(last_error) if last_error is not None else "no translation provider configured"
    raise AllProvidersFailedError(
        f"every translation provider failed: {message}",
        retryable=last_error.retryable if last_error is not None else True,
    )


def _assert_same_segments(
    requested: tuple[TranslationSegment, ...], returned: tuple[TranslatedSegment, ...]
) -> None:
    """A provider that drops or adds a segment breaks the SetSegmentText mapping."""
    if len(requested) != len(returned):
        raise ValueError(
            f"provider returned {len(returned)} segments for {len(requested)} requested"
        )
