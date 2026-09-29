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
transcript with nothing said in it gets no proposals: the contract documents an
empty list as a legitimate answer, and the run page offers "add a moment by
time" for it. A transcript whose words have no timings is not that: it fails,
``worker/transcript_untimed``, because "no strong moment" would blame the video
for what transcribing it again fixes.

2026-09-29, a language model picks with the heuristic. When a real model is
configured (``LLM_PROVIDER``; the mock does not count), the heuristic's best
windows, a few times more than asked for and spread across the video, go to the
model, which scores each one for standing alone, landing its point and humour
(and, with a ``topic``, for being about it) - by window id, never by timecode
(`worker_ai.highlights.rerank`). The two readings are blended into the potential
score, off-topic moments are dropped, and only then does ``minPotential`` apply.
With ``options.copy``, each pick also gets the words to post it with
(`worker_ai.highlights.clip_copy`). The model can make a pick better, never make
a run fail: anything it does not answer, in time or at all, is decided by rule,
exactly as before it existed.
"""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from pydantic import ValidationError

from worker_ai.callbacks import CallbackError, JobUsage
from worker_ai.highlights.clip_copy import ClipSource, heuristic_copy, resolve_style, write_copies
from worker_ai.highlights.contracts import (
    HIGHLIGHTS_SCHEMA_VERSION,
    ClipCopy,
    HighlightProposal,
    HighlightsOptions,
    HighlightsPayload,
    HighlightsResult,
)
from worker_ai.highlights.rerank import (
    MODEL_WEIGHT,
    TOPIC_FIT_FLOOR,
    Judged,
    MomentText,
    blend,
    judge_moments,
    model_quality,
    model_reasons,
    moment_text,
    shortlist_size,
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
    Unit,
    Window,
    Word,
    build_units,
    enumerate_windows,
    padded_windows,
    select,
    spoken_count,
    usable_words,
)
from worker_ai.llm.calls import CallLedger, Deadline, model_chain
from worker_ai.llm.pricing import inr_to_paise
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome

__all__ = ["HIGHLIGHT_MODEL", "UntimedTranscriptError", "discover", "process_highlights"]

_log = get_logger(__name__)

#: Stored on every candidate (``clip_candidates.model``), so a row says which
#: ranking produced it. ``montaj-highlight-v1`` was the time-ordered placeholder.
#: A ranking the language model took part in is this plus the model's id.
HIGHLIGHT_MODEL: Final[str] = "montaj-highlight-v2"
#: The contract's ceiling on ``windowsConsidered``.
_MAX_WINDOWS_REPORTED: Final[int] = 10_000
#: 4xx answers that are about load, not about this request, so worth asking again.
_TRANSIENT_CLIENT_STATUSES: Final = frozenset({408, 429})
#: How long one job may wait on the language model, judging and writing
#: together. Past it, whatever is left is decided by rule: a slow local model on
#: a busy GPU must not hold a run's moments back for long.
MODEL_DEADLINE_S: Final[float] = 8 * 60
#: Never fewer on-topic moments than this (or ``count``, if smaller): past it,
#: the closest off-topic ones fill in rather than leaving the run nearly empty.
_TOPIC_MINIMUM: Final[int] = 3


class UntimedTranscriptError(ValueError):
    """Most of what was said has no usable timing, so no moment can be placed.

    Raised by :func:`discover`, which stays a plain function for offline use;
    :func:`process_highlights` turns it into the job's failure code.
    """

    def __init__(self, *, spoken: int, timed: int) -> None:
        super().__init__(f"{timed} of {spoken} spoken words have a usable timing")
        self.spoken = spoken
        self.timed = timed


@dataclass(frozen=True, slots=True)
class _Candidate:
    window: Window
    signals: WindowSignals
    score: Score


@dataclass(frozen=True, slots=True)
class _Scored:
    """Every window of a transcript, scored by the heuristic."""

    words: list[Word]
    units: list[Unit]
    features: WordFeatures
    candidates: list[_Candidate]
    windows_considered: int
    timeline: tuple[int, int]


@dataclass(frozen=True, slots=True)
class _Ranked:
    """A candidate with the potential it is ranked on, and the model's view of it."""

    candidate: _Candidate
    potential: float
    judged: Judged | None = None


@dataclass(slots=True)
class _ModelUse:
    ledger: CallLedger = field(default_factory=CallLedger)
    judged: int = 0
    copies_by_model: int = 0


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


def _score_all(
    raw_words: Sequence[Any], options: HighlightsOptions, duration_ms: int
) -> _Scored | None:
    """Every window of the transcript with its heuristic score, or ``None`` for none.

    Raises :class:`UntimedTranscriptError` when most citable spoken words have
    no usable timing.
    """
    # Nothing said - no words, or only music notes and sound labels - is the
    # empty answer the contract documents, and the run offers "add a moment by
    # time" for it. So is speech with no id a proposal could cite (the API's
    # words endpoint always sends one): that is not a timing fault, and naming
    # it as one would send the user to transcribe again for nothing.
    spoken = spoken_count(raw_words)
    if spoken == 0:
        return None
    # Sarvam transcripts written before 2026-09-17 have every word at 0-0 (§9).
    # Cutting windows from timings like that would cut the wrong video, and an
    # empty answer would tell the user the video has no strong moment when it is
    # the transcript that is wrong. Counted over citable speech only, so the two
    # sides differ by timing alone: a song intro's notes are timed, but they are
    # not words, and are no reason to refuse the talk; a word with a malformed id
    # is in neither. A word with no timing at all never reaches `words`, so it
    # counts as untimed too - which also means `words` is not empty past this check.
    words = usable_words(raw_words)
    timed = sum(1 for word in words if word.end_ms > word.start_ms)
    if timed * 2 < spoken:
        raise UntimedTranscriptError(spoken=spoken, timed=timed)

    min_ms, max_ms = options.min_duration_ms, options.max_duration_ms
    speech_end_ms = max(word.end_ms for word in words)
    units = build_units(words, min_ms=min_ms, max_ms=max_ms)
    # The parts of the video the person asked to skip (`excludeRanges`) are
    # never a window, so never scored or proposed.
    exclude = options.exclude_ranges
    windows = enumerate_windows(
        units, min_ms=min_ms, max_ms=max_ms, exclude=exclude
    ) or padded_windows(
        units,
        min_ms=min_ms,
        max_ms=max_ms,
        timeline_end_ms=max(duration_ms, speech_end_ms),
        exclude=exclude,
    )
    if not windows:
        return None

    features = WordFeatures(words, units)
    candidates: list[_Candidate] = []
    for window in windows:
        signals = features.signals(window.first, window.last, window.start_ms, window.end_ms)
        candidates.append(_Candidate(window, signals, score(signals, options.content_goal)))
    return _Scored(
        words=words,
        units=units,
        features=features,
        candidates=candidates,
        windows_considered=min(len(windows), _MAX_WINDOWS_REPORTED),
        timeline=(words[0].start_ms, speech_end_ms),
    )


def _heuristic_pick(scored: _Scored, options: HighlightsOptions) -> list[_Candidate]:
    candidates = scored.candidates
    # Autopilot keeps only what clears the bar (`minPotential`): a moment that
    # scores under it is not worth a clip, however many slots are left.
    if options.min_potential is not None:
        floor = options.min_potential
        candidates = [candidate for candidate in candidates if candidate.score.potential >= floor]
        if not candidates:
            return []
    return select(
        candidates,
        count=options.count,
        window_of=lambda candidate: candidate.window,
        score_of=lambda candidate: candidate.score.potential,
        timeline=scored.timeline,
    )


def discover(
    raw_words: Sequence[Any], options: HighlightsOptions, duration_ms: int = 0
) -> tuple[list[HighlightProposal], int]:
    """The proposals for a transcript's words, best first, and how many windows were scored.

    Synchronous and deterministic: no network, no clock, no randomness, so the
    same words and options always give the same answer. This is the heuristic
    alone: the language model's part is :func:`process_highlights`'s.

    Raises :class:`UntimedTranscriptError` when most citable spoken words have
    no usable timing; a transcript with nothing said in it (or nothing a
    proposal could cite) is an empty answer instead.
    """
    scored = _score_all(raw_words, options, duration_ms)
    if scored is None:
        return [], 0
    picked = _heuristic_pick(scored, options)
    proposals = [
        _proposal(_Ranked(candidate, candidate.score.potential), scored) for candidate in picked
    ]
    return proposals, scored.windows_considered


def _proposal(
    ranked: _Ranked,
    scored: _Scored,
    *,
    topic: str | None = None,
    copy: dict[str, Any] | None = None,
) -> HighlightProposal:
    candidate = ranked.candidate
    window = candidate.window
    words = scored.words
    inside = words[window.first : window.last + 1]
    texts = [word.text for word in inside]
    reasons = [
        {"label": reason.label, "explanation": reason.explanation}
        for reason in reasons_for(
            candidate.signals,
            candidate.score,
            scored.features.emphatic_words(window.first, window.last),
        )
    ]
    judged = ranked.judged
    if judged is not None:
        # The model's view first: it is the one a person reads to decide.
        reasons = [
            {"label": label, "explanation": explanation}
            for label, explanation in model_reasons(judged, topic)
        ] + reasons
    fields: dict[str, Any] = {
        "windowId": window.window_id,
        "startMs": window.start_ms,
        "endMs": window.end_ms,
        "startWordId": inside[0].wid,
        "endWordId": inside[-1].wid,
        "title": make_title(texts, fallback=_moment_title(window.start_ms)),
        "transcriptExcerpt": make_excerpt(texts),
        "potentialScore": _percent(ranked.potential),
        "scoreBreakdown": candidate.score.breakdown(),
        "reasons": reasons[:12],
    }
    if judged is not None:
        fields["judgement"] = {
            "standalone": judged.standalone,
            "payoff": judged.payoff,
            "humour": judged.humour,
            **({} if judged.topic_fit is None else {"topicFit": judged.topic_fit}),
            "model": judged.model[:100] or "unknown",
        }
    if copy is not None:
        fields["copy"] = copy
    return HighlightProposal.model_validate(fields)


def _percent(value: float) -> int:
    # Half-up, as `Score.percent` does, so an unjudged moment keeps its figure.
    return math.floor(max(0.0, min(1.0, value)) * 100 + 0.5)


# ---------------------------------------------------------------------------
# With the language model
# ---------------------------------------------------------------------------


def _moment_texts(scored: _Scored, shortlist: Sequence[_Candidate]) -> list[MomentText]:
    """Each shortlisted window's words, with the sentence either side of it."""
    words, units = scored.words, scored.units
    unit_of_word: list[int] = [0] * len(words)
    for index, unit in enumerate(units):
        for position in range(unit.first, unit.last + 1):
            unit_of_word[position] = index

    def unit_text(index: int) -> str:
        if index < 0 or index >= len(units):
            return ""
        unit = units[index]
        return moment_text([word.text for word in words[unit.first : unit.last + 1]])

    items = []
    for candidate in shortlist:
        window = candidate.window
        items.append(
            MomentText(
                window_id=window.window_id,
                text=moment_text([word.text for word in words[window.first : window.last + 1]]),
                before=unit_text(unit_of_word[window.first] - 1) if window.first > 0 else "",
                after=(
                    unit_text(unit_of_word[window.last] + 1) if window.last + 1 < len(words) else ""
                ),
            )
        )
    return items


def _rank_with_model(
    shortlist: Sequence[_Candidate],
    judged: dict[str, Judged],
    answered: frozenset[str],
    options: HighlightsOptions,
) -> list[_Ranked]:
    """The shortlist re-scored with the model's judgement, filtered for topic and bar.

    A moment the model was asked about and left out is dropped: it saw it and
    passed. A moment whose batch no provider answered is kept, so an outage
    costs the model's opinion, not the moment; it is blended with the typical
    reading of the moments that were judged, so it ranks on the same scale as
    them rather than on the heuristic's alone.
    """
    topic = options.topic
    with_topic = bool(topic)
    goal = options.content_goal
    qualities = [model_quality(verdict, goal, with_topic=with_topic) for verdict in judged.values()]
    typical = sum(qualities) / len(qualities) if qualities else None
    entries: list[_Ranked] = []
    for candidate in shortlist:
        window_id = candidate.window.window_id
        verdict = judged.get(window_id)
        if verdict is None and window_id in answered:
            continue
        heuristic = candidate.score.potential
        if verdict is not None or typical is None:
            potential = blend(heuristic, verdict, goal, with_topic=with_topic)
        else:
            potential = (1 - MODEL_WEIGHT) * heuristic + MODEL_WEIGHT * typical
        entries.append(_Ranked(candidate, potential, verdict))

    if with_topic:
        on_topic = [
            entry
            for entry in entries
            if entry.judged is not None
            and entry.judged.topic_fit is not None
            and entry.judged.topic_fit >= TOPIC_FIT_FLOOR
        ]
        minimum = min(options.count, _TOPIC_MINIMUM)
        if len(on_topic) < minimum:
            # Too few on topic to be useful: the closest of the rest fill in,
            # best fit first, rather than a run with one clip.
            chosen = {id(entry) for entry in on_topic}
            rest = sorted(
                (entry for entry in entries if id(entry) not in chosen),
                key=lambda entry: (
                    -(
                        entry.judged.topic_fit
                        if entry.judged is not None and entry.judged.topic_fit is not None
                        else -1
                    ),
                    -entry.potential,
                ),
            )
            on_topic += rest[: minimum - len(on_topic)]
        entries = on_topic

    # `minPotential` is the bar for what the RANKING says a moment is worth,
    # so it applies to the blended score, after the model has had its say.
    if options.min_potential is not None:
        floor = options.min_potential
        entries = [entry for entry in entries if entry.potential >= floor]
    return entries


async def _discover_with_model(
    context: JobContext,
    payload: HighlightsPayload,
    raw_words: Sequence[Any],
    duration_ms: int,
) -> tuple[list[HighlightProposal], int, _ModelUse]:
    options = payload.options
    use = _ModelUse()
    scored = await asyncio.to_thread(_score_all, raw_words, options, duration_ms)
    if scored is None:
        return [], 0, use

    region = options.region or "in"
    chain = model_chain(context.services.llm_providers, region)
    deadline = Deadline(MODEL_DEADLINE_S)
    ranked: list[_Ranked] | None = None

    if chain:
        shortlist = await asyncio.to_thread(
            select,
            scored.candidates,
            count=shortlist_size(options.count),
            window_of=lambda candidate: candidate.window,
            score_of=lambda candidate: candidate.score.potential,
            timeline=scored.timeline,
        )
        items = _moment_texts(scored, shortlist)
        await context.progress(40, message=f"Reviewing {len(items)} moments with the AI editor")

        async def judged_batch(done: int, total: int) -> None:
            await context.progress(
                40 + 30 * done / max(1, total), message="Reviewing moments with the AI editor"
            )

        judgements = await judge_moments(
            items,
            chain=chain,
            goal=options.content_goal,
            topic=options.topic,
            deadline=deadline,
            ledger=use.ledger,
            on_batch=judged_batch,
        )
        use.judged = len(judgements.judged)
        if judgements.judged:
            ranked = _rank_with_model(shortlist, judgements.judged, judgements.answered, options)
            ranked = select(
                ranked,
                count=options.count,
                window_of=lambda entry: entry.candidate.window,
                score_of=lambda entry: entry.potential,
                timeline=scored.timeline,
            )

    if ranked is None:
        # No model, or no answer from it: the heuristic's own pick, as before.
        picked = await asyncio.to_thread(_heuristic_pick, scored, options)
        ranked = [_Ranked(candidate, candidate.score.potential) for candidate in picked]

    copies: dict[str, dict[str, Any]] = {}
    if options.copy_options is not None and ranked:
        sources = [
            ClipSource(
                key=entry.candidate.window.window_id,
                text=moment_text(
                    [
                        word.text
                        for word in scored.words[
                            entry.candidate.window.first : entry.candidate.window.last + 1
                        ]
                    ]
                ),
                title=make_title(
                    [
                        word.text
                        for word in scored.words[
                            entry.candidate.window.first : entry.candidate.window.last + 1
                        ]
                    ],
                    fallback=_moment_title(entry.candidate.window.start_ms),
                ),
            )
            for entry in ranked
        ]
        style = resolve_style(
            options.copy_options.language,
            options.copy_options.script_mode,
            " ".join(source.text for source in sources[:5]),
        )
        await context.progress(75, message="Writing titles and captions")

        async def wrote_batch(done: int, total: int) -> None:
            await context.progress(
                75 + 15 * done / max(1, total), message="Writing titles and captions"
            )

        copies = await write_copies(
            sources,
            style=style,
            topic=options.topic,
            chain=chain,
            deadline=deadline,
            ledger=use.ledger,
            on_batch=wrote_batch,
        )
        use.copies_by_model = sum(1 for copy in copies.values() if copy.get("source") == "model")

    proposals = [
        _proposal(
            entry,
            scored,
            topic=options.topic,
            copy=copies.get(entry.candidate.window.window_id),
        )
        for entry in ranked
    ]
    return proposals, scored.windows_considered, use


def _discover_by_rule(
    raw_words: Sequence[Any], options: HighlightsOptions, duration_ms: int
) -> tuple[list[HighlightProposal], int]:
    """:func:`discover`, with the rule-based copy when copy was asked for."""
    proposals, windows_considered = discover(raw_words, options, duration_ms)
    if options.copy_options is None or not proposals:
        return proposals, windows_considered
    style = resolve_style(
        options.copy_options.language,
        options.copy_options.script_mode,
        " ".join(proposal.transcript_excerpt for proposal in proposals[:5]),
    )
    written = [
        proposal.model_copy(
            update={
                "copy_text": ClipCopy.model_validate(
                    heuristic_copy(
                        ClipSource(
                            key=proposal.window_id,
                            text=proposal.transcript_excerpt,
                            title=proposal.title,
                        ),
                        style,
                    )
                )
            }
        )
        for proposal in proposals
    ]
    return written, windows_considered


def _ranking_model(proposals: Sequence[HighlightProposal]) -> str:
    """``montaj-highlight-v2``, plus the model that judged most of the picks."""
    models = Counter(
        proposal.judgement.model for proposal in proposals if proposal.judgement is not None
    )
    if not models:
        return HIGHLIGHT_MODEL
    return f"{HIGHLIGHT_MODEL}+{models.most_common(1)[0][0]}"[:100]


def _usage(use: _ModelUse) -> JobUsage | None:
    provider = use.ledger.paid_provider
    if provider is None:
        return None
    name, model = provider
    return JobUsage(
        provider=name,
        model=model or None,
        cost_minor=inr_to_paise(use.ledger.cost_inr),
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
    options = payload.options
    uses_model = (
        bool(model_chain(context.services.llm_providers, options.region or "in"))
        or options.copy_options is not None
    )
    use = _ModelUse()
    try:
        if uses_model:
            try:
                proposals, windows_considered, use = await _discover_with_model(
                    context, payload, raw_words, duration_ms
                )
            except UntimedTranscriptError:
                raise
            except Exception:
                # The model's part must never fail the run, whatever went wrong
                # in it: the heuristic's pick, with copy by rule, as before it.
                _log.exception(
                    "highlight discovery with the language model failed; answering by rule",
                    extra={"runId": payload.run_id, "transcriptId": payload.transcript_id},
                )
                proposals, windows_considered = await asyncio.to_thread(
                    _discover_by_rule, raw_words, options, duration_ms
                )
        else:
            # Up to a few seconds of CPU for a long source. On the event loop it
            # would stall every other AI queue this process serves - their
            # progress calls, heartbeats and BullMQ lock renewals - for as long
            # as it ran.
            proposals, windows_considered = await asyncio.to_thread(
                discover, raw_words, options, duration_ms
            )
    except UntimedTranscriptError as error:
        # Not retryable: the same words give the same answer. The API fails the
        # run with `repurpose/transcript_untimed`, whose page names the remedy -
        # transcribe the video again - instead of "no strong moment".
        _log.warning(
            "most transcript words have no usable timing",
            extra={
                "runId": payload.run_id,
                "transcriptId": payload.transcript_id,
                "words": error.spoken,
                "timedWords": error.timed,
            },
        )
        raise JobFailureError(
            "worker/transcript_untimed",
            f"transcript {payload.transcript_id} cannot be cut into moments: {error}",
            retryable=False,
        ) from error
    _log.info(
        "highlight discovery finished",
        extra={
            "runId": payload.run_id,
            "transcriptId": payload.transcript_id,
            "words": len(raw_words),
            "windowsConsidered": windows_considered,
            "proposals": len(proposals),
            "judged": use.judged,
            "copiesByModel": use.copies_by_model,
            "llmCalls": use.ledger.calls,
            "llmInputTokens": use.ledger.input_tokens,
            "llmOutputTokens": use.ledger.output_tokens,
            "llmCostInr": round(use.ledger.cost_inr, 4),
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
            "model": _ranking_model(proposals),
            "windowsConsidered": windows_considered,
        }
    )

    await context.progress(100, message="Highlight discovery complete")

    # `exclude_none`: an optional field the worker did not fill (a proposal's
    # `copy` or `judgement`) is left out, never sent as null - the TypeScript
    # contract's optional fields accept a missing key, not a null one.
    return ProcessorOutcome(
        result=result.model_dump(by_alias=True, mode="json", exclude_none=True),
        usage=_usage(use),
    )
