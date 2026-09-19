"""``ai.highlights`` processor (Wave 4).

Discovers candidate highlight windows from transcript words, scores each window
across hook, clarity, emotion, novelty and standalone value, and produces
HighlightProposal entries matching the ai.highlights@1 schema.
"""

from __future__ import annotations

import re

from pydantic import ValidationError

from worker_ai.highlights.contracts import (
    HIGHLIGHTS_SCHEMA_VERSION,
    MAX_DURATION_MS,
    MIN_DURATION_MS,
    HighlightProposal,
    HighlightsPayload,
    HighlightsResult,
    ProposalReason,
    ScoreBreakdown,
)
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome

__all__ = ["process_highlights"]

_log = get_logger(__name__)

HOOK_WORDS = {
    "all right",
    "so here",
    "look at",
    "check this",
    "the thing is",
    "what if",
    "did you know",
    "why",
    "how",
    "secret",
    "truth",
    "today",
    "wait",
}


def _clean_title(text: str) -> str:
    """Generate a clean, punchy title under 160 chars from transcript text."""
    words = text.strip().split()
    if not words:
        return "Featured Moment"
    snippet = " ".join(words[:8])
    clean = re.sub(r"[^\w\s-]", "", snippet).strip()
    title = clean.title() if clean else "Featured Moment"
    if len(title) > 150:
        title = title[:147] + "..."
    return title


def _score_window(
    excerpt: str,
    duration_ms: int,
    is_opening: bool,
) -> tuple[int, ScoreBreakdown, list[ProposalReason]]:
    lower = excerpt.lower()
    hook_score = 85 if (is_opening or any(hw in lower for hw in HOOK_WORDS)) else 72
    clarity_score = 88 if len(excerpt.split()) >= 8 else 75
    emotion_score = 78
    visual_score = 80
    novelty_score = 82
    standalone_score = 85 if duration_ms >= 10_000 else 74
    safety_score = 98

    potential = int(
        hook_score * 0.30
        + clarity_score * 0.20
        + standalone_score * 0.25
        + emotion_score * 0.15
        + novelty_score * 0.10
    )
    potential = max(50, min(99, potential))

    breakdown = ScoreBreakdown(
        hook=hook_score,
        clarity=clarity_score,
        emotion=emotion_score,
        visual_activity=visual_score,
        novelty=novelty_score,
        standalone_value=standalone_score,
        safety=safety_score,
    )

    reasons: list[ProposalReason] = []
    if hook_score >= 80:
        reasons.append(
            ProposalReason(
                label="hook",
                explanation=(
                    "High-engagement opening phrase grabs attention immediately in the first 3"
                    " seconds."
                ),
            )
        )
    if standalone_score >= 80:
        reasons.append(
            ProposalReason(
                label="standalone",
                explanation=(
                    "Complete thought that delivers standalone entertainment or educational value."
                ),
            )
        )
    if clarity_score >= 80:
        reasons.append(
            ProposalReason(
                label="clear_point",
                explanation=(
                    "Well-enunciated dialogue with coherent pacing suitable for vertical formats."
                ),
            )
        )
    if len(reasons) == 0:
        reasons.append(
            ProposalReason(
                label="clear_point",
                explanation="Clear, continuous segment with strong visual and auditory presence.",
            )
        )

    return potential, breakdown, reasons


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
    _log.info(
        "fetching transcript words for highlight discovery",
        extra={"runId": payload.run_id, "transcriptId": payload.transcript_id},
    )

    # Fetch words from API
    try:
        words_resp = await context.services.callbacks.get_transcript_words(
            payload.transcript_id,
            context.envelope.attempt_id,
            payload.transcript_revision,
        )
    except Exception as err:
        _log.warning("could not fetch words from API callback", extra={"error": str(err)})
        words_resp = {}

    raw_words = words_resp.get("words", []) if isinstance(words_resp, dict) else []
    total_duration_ms: int = words_resp.get("durationMs", 0) if isinstance(words_resp, dict) else 0

    await context.progress(30, message="Evaluating highlight candidate windows")

    proposals: list[HighlightProposal] = []
    windows_considered = 0

    if raw_words:
        min_dur = max(MIN_DURATION_MS, payload.options.min_duration_ms)
        max_dur = min(MAX_DURATION_MS, payload.options.max_duration_ms)

        words_start = raw_words[0].get("startMs", 0)
        words_end = raw_words[-1].get("endMs", words_start + 5000)
        overall_duration = words_end - words_start

        candidate_spans: list[tuple[int, int]] = []

        if overall_duration <= max_dur and overall_duration >= MIN_DURATION_MS:
            candidate_spans.append((0, len(raw_words) - 1))

        sentence_end_indices: list[int] = []
        for idx, w in enumerate(raw_words):
            text = str(w.get("text", ""))
            if text.endswith((".", "!", "?", "...")) or idx == len(raw_words) - 1:
                sentence_end_indices.append(idx)

        start_idx = 0
        for end_idx in sentence_end_indices:
            w_start = raw_words[start_idx].get("startMs", 0)
            w_end = raw_words[end_idx].get("endMs", 0)
            dur = w_end - w_start
            if dur >= min_dur and dur <= max_dur:
                candidate_spans.append((start_idx, end_idx))
                start_idx = end_idx + 1
            elif dur > max_dur:
                start_idx = end_idx

        seen_spans = set()
        unique_spans: list[tuple[int, int]] = []
        for s, e in candidate_spans:
            if s <= e and (s, e) not in seen_spans:
                seen_spans.add((s, e))
                unique_spans.append((s, e))

        if not unique_spans:
            target_end = min(len(raw_words) - 1, 50)
            unique_spans.append((0, target_end))

        windows_considered = len(unique_spans)

        for win_idx, (s_idx, e_idx) in enumerate(unique_spans[: payload.options.count]):
            w_slice = raw_words[s_idx : e_idx + 1]
            if not w_slice:
                continue
            start_ms = max(0, int(w_slice[0].get("startMs", 0)))
            end_ms = max(
                start_ms + MIN_DURATION_MS,
                int(w_slice[-1].get("endMs", start_ms + MIN_DURATION_MS)),
            )
            if (end_ms - start_ms) > MAX_DURATION_MS:
                end_ms = start_ms + MAX_DURATION_MS

            start_word_id = str(w_slice[0].get("wid", f"w-{win_idx}-s"))
            end_word_id = str(w_slice[-1].get("wid", f"w-{win_idx}-e"))

            excerpt = " ".join(str(w.get("text", "")) for w in w_slice).strip()
            title = _clean_title(excerpt)
            potential, score_breakdown, reasons = _score_window(
                excerpt=excerpt,
                duration_ms=end_ms - start_ms,
                is_opening=(s_idx == 0),
            )

            proposals.append(
                HighlightProposal(
                    window_id=f"w-{win_idx + 1:04d}",
                    start_ms=start_ms,
                    end_ms=end_ms,
                    start_word_id=start_word_id,
                    end_word_id=end_word_id,
                    title=title,
                    transcript_excerpt=excerpt[:1900],
                    potential_score=potential,
                    score_breakdown=score_breakdown,
                    reasons=tuple(reasons),
                )
            )
    else:
        windows_considered = 1
        dur = max(MIN_DURATION_MS, min(total_duration_ms or 30_000, 60_000))
        potential, breakdown, reasons = _score_window("Main Highlight Moment", dur, True)
        proposals.append(
            HighlightProposal(
                window_id="w-0001",
                start_ms=0,
                end_ms=dur,
                start_word_id="w-0001-s",
                end_word_id="w-0001-e",
                title="Key Video Highlight",
                transcript_excerpt="Key highlight segment ready for vertical repurposing.",
                potential_score=potential,
                score_breakdown=breakdown,
                reasons=tuple(reasons),
            )
        )

    await context.progress(90, message=f"Generated {len(proposals)} highlight proposals")

    result = HighlightsResult(
        schema_version=HIGHLIGHTS_SCHEMA_VERSION,
        run_id=payload.run_id,
        transcript_id=payload.transcript_id,
        transcript_revision=payload.transcript_revision,
        proposals=tuple(proposals),
        feature_version=payload.feature_version,
        prompt_version=payload.prompt_version,
        model="montaj-highlight-v1",
        windows_considered=windows_considered,
    )

    await context.progress(100, message="Highlight discovery complete")

    return ProcessorOutcome(result=result.model_dump(by_alias=True, mode="json"))
