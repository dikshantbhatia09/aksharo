"""``ai.highlights`` processor: the best moments of the whole video, from its words.

Enumerate, score, select (``worker_ai.highlights``): sentence windows across the
entire transcript, each scored on what its words actually say, and the best
``count`` picked without overlap and spread across the video. The first version
returned the first ``count`` sentence windows in time order with constant
scores, so every suggestion of a six-minute video came from its first 91 s.

Deterministic on purpose: the same words and options always give the same
proposals, in the same order, with the same scores. The API ranks candidates by
the order they arrive in (``rank = index + 1``), so they are sent best first.

It never invents a moment. A words fetch that fails raises a retryable
:class:`JobFailureError` - the first version swallowed it and reported a made-up
"Key Video Highlight" at 0-30 s as a success, which then could not be re-run. A
transcript with no usable words gets no proposals: the contract documents an
empty list as a legitimate answer, and the run page offers "add a moment by
time" for it.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

from pydantic import ValidationError

from worker_ai.callbacks import CallbackError
from worker_ai.highlights.contracts import (
    HIGHLIGHTS_SCHEMA_VERSION,
    HighlightProposal,
    HighlightsOptions,
    HighlightsPayload,
    HighlightsResult,
)
from worker_ai.highlights.scoring import (
    Score,
    WindowSignals,
    WordFeatures,
    reasons_for,
    score,
)
from worker_ai.highlights.text import make_excerpt, make_title
from worker_ai.highlights.windows import (
    Window,
    Word,
    build_units,
    enumerate_windows,
    padded_windows,
    select,
    spoken_count,
    usable_words,
)
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome

__all__ = ["HIGHLIGHT_MODEL", "discover", "process_highlights"]

_log = get_logger(__name__)

#: Stored on every candidate (``clip_candidates.model``), so a row says which
#: ranking produced it. ``montaj-highlight-v1`` was the time-ordered placeholder.
HIGHLIGHT_MODEL: Final[str] = "montaj-highlight-v2"
#: The contract's ceiling on ``windowsConsidered``.
_MAX_WINDOWS_REPORTED: Final[int] = 10_000
#: 4xx answers that are about load, not about this request, so worth asking again.
_TRANSIENT_CLIENT_STATUSES: Final = frozenset({408, 429})


@dataclass(frozen=True, slots=True)
class _Candidate:
    window: Window
    signals: WindowSignals
    score: Score


async def _fetch_words(context: JobContext, payload: HighlightsPayload) -> tuple[list[Any], int]:
    """The transcript's words and the duration the API reports, or a job failure.

    Never an empty list standing in for an error: that is exactly how the first
    version turned an API restart into an invented candidate.
    """
    try:
        response = await context.services.callbacks.get_transcript_words(
            payload.transcript_id,
            context.envelope.attempt_id,
            payload.transcript_revision,
        )
    except CallbackError as error:
        status = error.status_code
        # A 4xx is the API refusing this request for good - a bad signature, an
        # unknown transcript - and asking again cannot change the answer. No
        # status (unreachable), a 5xx or a 429 is the API being briefly away,
        # typically mid-restart, and BullMQ's retry is what gets past it.
        permanent = (
            status is not None and 400 <= status < 500 and status not in _TRANSIENT_CLIENT_STATUSES
        )
        raise JobFailureError(
            "worker/transcript_unavailable" if permanent else "worker/callback_unavailable",
            f"could not fetch the transcript words: {error}",
            retryable=not permanent,
        ) from error
    except Exception as error:  # a body that is not JSON, a connection dropped mid-read
        raise JobFailureError(
            "worker/callback_unavailable",
            f"could not fetch the transcript words: {error}",
            retryable=True,
        ) from error

    words = response.get("words") if isinstance(response, dict) else None
    if not isinstance(words, list):
        raise JobFailureError(
            "worker/callback_unavailable",
            "the transcript words response carried no word list",
            retryable=True,
        )
    project_id = response.get("projectId")
    if not isinstance(project_id, str):
        # The words endpoint answers a transcript it does not know with a 200 and
        # an empty list, and that is the only answer without a projectId. Read as
        # "no speech", it would tell the user the video has no moments when the
        # transcript the job was pinned to is simply gone.
        raise JobFailureError(
            "worker/transcript_unavailable",
            f"transcript {payload.transcript_id} is not known to the API",
            retryable=False,
        )
    if project_id != payload.project_id:
        raise JobFailureError(
            "worker/invalid_payload",
            f"transcript {payload.transcript_id} does not belong to project {payload.project_id}",
            retryable=False,
        )
    return words, _duration_ms(response.get("durationMs"))


def _duration_ms(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0
    if not math.isfinite(value) or value <= 0:
        return 0
    return round(value)


def _moment_title(start_ms: int) -> str:
    """A factual title for a window whose words leave nothing readable."""
    seconds = start_ms // 1000
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    stamp = f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"
    return f"Moment at {stamp}"


def discover(
    raw_words: Sequence[Any], options: HighlightsOptions, duration_ms: int = 0
) -> tuple[list[HighlightProposal], int]:
    """The proposals for a transcript's words, best first, and how many windows were scored.

    Synchronous and deterministic: no network, no clock, no randomness, so the
    same words and options always give the same answer.
    """
    words = usable_words(raw_words)
    if not words:
        return [], 0
    # Sarvam transcripts written before 2026-09-17 have every word at 0-0 (§9).
    # Cutting windows from timings like that would cut the wrong video, so the
    # honest answer is none. Counted over speech only: a song intro's notes are
    # timed, but they are not words, and are no reason to refuse the talk.
    timed = sum(1 for word in words if word.end_ms > word.start_ms)
    spoken = spoken_count(raw_words)
    if timed * 2 < spoken:
        _log.warning(
            "most transcript words have no usable timing; proposing nothing",
            extra={"words": spoken, "timedWords": timed},
        )
        return [], 0

    min_ms, max_ms = options.min_duration_ms, options.max_duration_ms
    speech_end_ms = max(word.end_ms for word in words)
    units = build_units(words, min_ms=min_ms, max_ms=max_ms)
    windows = enumerate_windows(units, min_ms=min_ms, max_ms=max_ms) or padded_windows(
        units, min_ms=min_ms, max_ms=max_ms, timeline_end_ms=max(duration_ms, speech_end_ms)
    )
    if not windows:
        return [], 0

    features = WordFeatures(words, units)
    candidates: list[_Candidate] = []
    for window in windows:
        signals = features.signals(window.first, window.last, window.start_ms, window.end_ms)
        candidates.append(_Candidate(window, signals, score(signals, options.content_goal)))

    picked = select(
        candidates,
        count=options.count,
        window_of=lambda candidate: candidate.window,
        score_of=lambda candidate: candidate.score.potential,
        timeline=(words[0].start_ms, speech_end_ms),
    )
    proposals = [_proposal(candidate, words, features) for candidate in picked]
    return proposals, min(len(windows), _MAX_WINDOWS_REPORTED)


def _proposal(
    candidate: _Candidate, words: Sequence[Word], features: WordFeatures
) -> HighlightProposal:
    window = candidate.window
    inside = words[window.first : window.last + 1]
    texts = [word.text for word in inside]
    reasons = reasons_for(
        candidate.signals,
        candidate.score,
        features.emphatic_words(window.first, window.last),
    )
    return HighlightProposal.model_validate(
        {
            "windowId": window.window_id,
            "startMs": window.start_ms,
            "endMs": window.end_ms,
            "startWordId": inside[0].wid,
            "endWordId": inside[-1].wid,
            "title": make_title(texts, fallback=_moment_title(window.start_ms)),
            "transcriptExcerpt": make_excerpt(texts),
            "potentialScore": candidate.score.percent(),
            "scoreBreakdown": candidate.score.breakdown(),
            "reasons": [
                {"label": reason.label, "explanation": reason.explanation} for reason in reasons
            ],
        }
    )


async def process_highlights(context: JobContext) -> ProcessorOutcome:
    """Consumes `ai.highlights` jobs and discovers highlight candidates."""
    try:
        payload = HighlightsPayload.model_validate(context.envelope.payload)
    except ValidationError as err:
        raise JobFailureError(
            "worker/invalid_payload",
            f"ai.highlights payload is malformed: {err}",
            retryable=False,
        ) from err

    await context.progress(10, message="Fetching transcript words")
    raw_words, duration_ms = await _fetch_words(context, payload)

    await context.progress(30, message="Evaluating highlight candidate windows")
    # Up to a few seconds of CPU for a long source. On the event loop it would
    # stall every other AI queue this process serves - their progress calls,
    # heartbeats and BullMQ lock renewals - for as long as it ran.
    proposals, windows_considered = await asyncio.to_thread(
        discover, raw_words, payload.options, duration_ms
    )
    _log.info(
        "highlight discovery finished",
        extra={
            "runId": payload.run_id,
            "transcriptId": payload.transcript_id,
            "words": len(raw_words),
            "windowsConsidered": windows_considered,
            "proposals": len(proposals),
        },
    )

    await context.progress(90, message=f"Generated {len(proposals)} highlight proposals")

    result = HighlightsResult.model_validate(
        {
            "schemaVersion": HIGHLIGHTS_SCHEMA_VERSION,
            "runId": payload.run_id,
            "transcriptId": payload.transcript_id,
            "transcriptRevision": payload.transcript_revision,
            "proposals": proposals,
            "featureVersion": payload.feature_version,
            "promptVersion": payload.prompt_version,
            "model": HIGHLIGHT_MODEL,
            "windowsConsidered": windows_considered,
        }
    )

    await context.progress(100, message="Highlight discovery complete")

    return ProcessorOutcome(result=result.model_dump(by_alias=True, mode="json"))
