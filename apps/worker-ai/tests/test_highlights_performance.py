"""``ai.highlights`` with a workspace's track record (2026-10-05): ``options.performance``.

The lift must do three things and nothing more: break near-ties toward moments
like the workspace's best clips (and the length or opening that did best), say
so in the moment's reasons, and never change which moments the person's own
steering allows - the topic, the bar, the count. Without the option, nothing
about an answer changes.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from worker_ai.highlights import HighlightsResult
from worker_ai.highlights.contracts import PerformanceSignal
from worker_ai.highlights.performance import (
    HIT_LIFT,
    HOOK_LIFT,
    LENGTH_LIFT,
    MAX_LIFT,
    Lift,
    TrackRecord,
    hook_style,
    keywords,
    lift_for,
    reason_for,
)
from worker_ai.processors.highlights import discover

from .fake_llm import FakeLlm
from .test_highlights import NEUTRAL, STRONG_AT_12, options, talk
from .test_highlights_rerank import judge, run_with

CRICKET = ("my first cricket bat was a gift from my grandfather in the village.",)
BICYCLE = ("my first bicycle was a gift from my grandfather in the village.",)
PUNCHLINE = (
    "then my uncle told the punchline about the old bus and the goat.",
    "the whole room laughed at that punchline for five minutes.",
)
SHORT_WINDOWS = {"minDurationMs": 15_000, "maxDurationMs": 30_000}


def transcript(*blocks: Sequence[str], filler: int = 8) -> list[dict[str, Any]]:
    """Neutral talk around each block, so every block is its own moment."""
    sentences: list[str] = []
    for index, block in enumerate(blocks):
        sentences.extend(NEUTRAL[(index + k) % len(NEUTRAL)] for k in range(filler))
        sentences.extend(block)
    sentences.extend(NEUTRAL[k % len(NEUTRAL)] for k in range(filler))
    return talk(sentences)


def signal(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "basis": 9,
        "hits": [{"title": "My grandfather's cricket bat", "views": 12_400, "platform": "youtube"}],
    }
    return base | overrides


def record(**overrides: Any) -> TrackRecord:
    return TrackRecord.of(PerformanceSignal.model_validate(signal(**overrides)), [])


def track_reasons(proposal: Any) -> list[str]:
    return [reason.explanation for reason in proposal.reasons if reason.label == "track_record"]


# ---------------------------------------------------------------------------
# Words and openings
# ---------------------------------------------------------------------------


def test_keywords_keep_content_words_in_every_script() -> None:
    assert keywords("My grandfather's cricket bat") == {"grandfather", "cricket"}
    # Plurals fold, numbers and short or common words go.
    assert keywords("Savings: 90 tips that REALLY work") == {"saving", "tips", "work"}
    assert keywords("Salary aate hi ye galti mat karna") == {"salary", "aate", "galti"}
    # Devanagari keeps its vowel signs; two-letter words go.
    assert keywords("पैसा बचाने के तरीके") == {"पैसा", "बचाने", "तरीके"}


@pytest.mark.parametrize(
    ("text", "style"),
    [
        ("Did you know that 90 percent of people never check this?", "question"),
        ("Kya aapko pata hai ki ye galti sab karte hain", "question"),
        ("क्या आप जानते हैं", "question"),
        ("Why nobody tells you this", "question"),
        ("90 percent of people never check this", "number"),
        ("Three things I wish I knew", "number"),
        ("You are doing this wrong", "you"),
        ("Aap ye galti karte ho", "you"),
        ("The market fell today", "statement"),
        ("", "statement"),
    ],
)
def test_openings_are_read_the_way_the_api_reads_hooks(text: str, style: str) -> None:
    assert hook_style(text) == style


# ---------------------------------------------------------------------------
# The lift, and its bounds
# ---------------------------------------------------------------------------


def test_a_moment_like_a_hit_is_lifted_more_the_more_it_shares() -> None:
    track = record(
        hits=[{"title": "Cricket bat grandfather village gift", "views": 10, "platform": "x"}]
    )
    one = lift_for(track, frozenset({"cricket"}), 20_000, "")
    two = lift_for(track, frozenset({"cricket", "grandfather"}), 20_000, "")
    four = lift_for(track, frozenset({"cricket", "grandfather", "village", "gift"}), 20_000, "")
    assert one.value == 0
    assert two.value == pytest.approx(HIT_LIFT / 2)
    assert four.value == pytest.approx(HIT_LIFT)
    assert four.shared == ("cricket", "gift", "grandfather", "village")


def test_sharing_only_the_passing_words_of_what_was_said_is_not_being_alike() -> None:
    track = record(
        hits=[
            {
                "title": "Why my first SIP failed",
                "excerpt": "we walked to the market after lunch and talked about plans",
                "views": 10,
                "platform": "youtube",
            }
        ]
    )
    # Only excerpt words: not lifted.
    assert lift_for(track, frozenset({"market", "lunch", "plan"}), 20_000, "").value == 0
    # A title word and an excerpt word: lifted.
    assert lift_for(track, frozenset({"failed", "market"}), 20_000, "").value > 0


def test_words_the_whole_video_says_do_not_count() -> None:
    sentences = [frozenset({"cricket", "match"})] * 6 + [frozenset({"weather"})] * 4
    track = TrackRecord.of(PerformanceSignal.model_validate(signal()), sentences)
    assert "cricket" in track.common
    assert lift_for(track, frozenset({"cricket", "grandfather"}), 20_000, "").value == 0


def test_the_lift_is_capped_whatever_matches() -> None:
    track = record(
        hits=[{"title": "cricket grandfather village gift", "views": 10, "platform": "x"}],
        length={"minMs": 15_000, "maxMs": 30_000, "posts": 6},
        hook={"style": "question", "posts": 5},
    )
    everything = lift_for(
        track,
        frozenset({"cricket", "grandfather", "village", "gift"}),
        20_000,
        "Why did my grandfather keep that bat?",
    )
    assert HIT_LIFT + LENGTH_LIFT + HOOK_LIFT > MAX_LIFT
    assert everything.value == pytest.approx(MAX_LIFT)
    assert everything.length and everything.hook
    # Outside the band, or opening another way: neither applies.
    neither = lift_for(track, frozenset(), 45_000, "The bat was old.")
    assert neither.value == 0


def test_reasons_say_which_clip_or_which_pattern() -> None:
    track = record(
        length={"minMs": 20_000, "maxMs": 40_000, "posts": 7},
        hook={"style": "question", "posts": 6},
    )
    hit = PerformanceSignal.model_validate(signal()).hits[0]
    assert reason_for(Lift(0.02, hit=hit, shared=("cricket", "grandfather")), track) == (
        "track_record",
        "Like your clip “My grandfather's cricket bat” (12.4k views on YouTube): "
        "cricket, grandfather.",
    )
    assert reason_for(Lift(0.015, length=True), track) == (
        "track_record",
        "The length your clips do best at: 20 s to 40 s (7 posts).",
    )
    assert reason_for(Lift(0.01, hook=True), track) == (
        "track_record",
        "It opens with a question, like your clips that did best (6 posts).",
    )
    both = reason_for(Lift(0.025, length=True, hook=True), track)
    assert both is not None and "(7 and 6 posts)" in both[1]
    assert reason_for(Lift(0.0), track) is None


def test_views_read_the_way_a_person_says_them() -> None:
    track = record()
    for views, said in [(950, "950"), (12_400, "12.4k"), (40_000, "40k"), (1_500_000, "1.5M")]:
        hit = PerformanceSignal.model_validate(
            signal(hits=[{"title": "A clip", "views": views, "platform": "tiktok"}])
        ).hits[0]
        reason = reason_for(Lift(0.02, hit=hit, shared=("a", "b")), track)
        assert reason is not None and f"({said} views on TikTok)" in reason[1]


# ---------------------------------------------------------------------------
# Picking moments
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("order", ["cricket-first", "bicycle-first"])
def test_a_near_tie_goes_to_the_moment_like_a_hit(order: str) -> None:
    blocks = (CRICKET, BICYCLE) if order == "cricket-first" else (BICYCLE, CRICKET)
    words = transcript(*blocks)

    (picked,), _ = discover(words, options(count=1, performance=signal(), **SHORT_WINDOWS))

    assert "cricket" in picked.transcript_excerpt
    assert track_reasons(picked) == [
        "Like your clip “My grandfather's cricket bat” (12.4k views on YouTube): "
        "cricket, grandfather."
    ]


def test_a_lift_never_overturns_a_clearly_better_moment() -> None:
    words = transcript(CRICKET, STRONG_AT_12)
    plain, _ = discover(words, options(count=3, **SHORT_WINDOWS))
    lifted, _ = discover(words, options(count=3, performance=signal(), **SHORT_WINDOWS))

    assert "Did you know" in plain[0].transcript_excerpt
    assert lifted[0].transcript_excerpt == plain[0].transcript_excerpt
    assert lifted[0].potential_score == plain[0].potential_score
    # The moment like the hit gains, by no more than the cap.
    by_window = {proposal.window_id: proposal.potential_score for proposal in plain}
    for proposal in lifted:
        if track_reasons(proposal) and proposal.window_id in by_window:
            gain = proposal.potential_score - by_window[proposal.window_id]
            assert 0 < gain <= round(MAX_LIFT * 100)


def test_the_bar_reads_the_potential_without_the_lift() -> None:
    words = transcript(CRICKET, STRONG_AT_12)
    lifted, _ = discover(words, options(count=5, performance=signal(), **SHORT_WINDOWS))
    like_hit = next(proposal for proposal in lifted if track_reasons(proposal))
    # Set the bar a point above what that moment scores without its lift.
    bar = (like_hit.potential_score - 1) / 100

    plain, _ = discover(words, options(count=5, minPotential=bar, **SHORT_WINDOWS))
    steered, _ = discover(
        words, options(count=5, minPotential=bar, performance=signal(), **SHORT_WINDOWS)
    )

    plain_windows = {proposal.window_id for proposal in plain}
    assert like_hit.window_id not in plain_windows
    # The lift would carry it over the bar; it is not allowed to.
    assert {proposal.window_id for proposal in steered} == plain_windows


def test_a_signal_that_matches_nothing_changes_nothing() -> None:
    words = transcript(CRICKET, BICYCLE, STRONG_AT_12)
    unrelated = signal(
        hits=[{"title": "Quarterly tax filing deadlines", "views": 9_000, "platform": "linkedin"}]
    )
    plain, _ = discover(words, options(count=4, **SHORT_WINDOWS))
    steered, _ = discover(words, options(count=4, performance=unrelated, **SHORT_WINDOWS))
    assert [p.model_dump() for p in steered] == [p.model_dump() for p in plain]


def test_the_length_that_did_best_is_named() -> None:
    words = transcript(CRICKET, BICYCLE)
    band = {"minMs": 15_000, "maxMs": 31_000, "posts": 6}
    steered, _ = discover(
        words, options(count=2, performance=signal(hits=[], length=band), **SHORT_WINDOWS)
    )
    assert all(
        track_reasons(proposal) == ["The length your clips do best at: 15 s to 31 s (6 posts)."]
        for proposal in steered
    )


async def test_the_topic_decides_what_is_allowed_whatever_the_track_record_says() -> None:
    words = transcript(CRICKET, PUNCHLINE)
    about_the_punchline = signal(
        hits=[
            {
                "title": "My uncle's punchline about the goat",
                "hook": "The goat punchline",
                "views": 90_000,
                "platform": "instagram",
            }
        ]
    )

    def scores(text: str) -> tuple[int, int, int, int]:
        # The model rates the punchline higher on everything but the topic.
        if "punchline" in text:
            return (9, 9, 8, 1)
        return (6, 6, 0, 9 if "cricket" in text else 1)

    outcome = await run_with(
        (FakeLlm(judge(scores)),),
        words,
        count=1,
        topic="cricket memories",
        performance=about_the_punchline,
        **SHORT_WINDOWS,
    )
    (proposal,) = outcome.result["proposals"]
    assert "cricket" in proposal["transcriptExcerpt"]
    assert "punchline" not in proposal["transcriptExcerpt"]
    # What the worker sends parses as the contract, `track_record` and all.
    HighlightsResult.model_validate(outcome.result)


async def test_the_model_path_names_the_lift_too() -> None:
    words = transcript(CRICKET, BICYCLE)

    def scores(_text: str) -> tuple[int, int, int, int]:
        return (6, 6, 0, 5)

    outcome = await run_with(
        (FakeLlm(judge(scores)),), words, count=1, performance=signal(), **SHORT_WINDOWS
    )
    (proposal,) = outcome.result["proposals"]
    assert "cricket" in proposal["transcriptExcerpt"]
    labels = [reason["label"] for reason in proposal["reasons"]]
    # The model's view first, then the track record, then the heuristic's detail.
    assert labels[0] == "standalone"
    assert labels[1] == "track_record"
