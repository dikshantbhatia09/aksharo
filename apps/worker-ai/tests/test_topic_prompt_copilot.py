"""Automated test suite for Pillar 2 §06: Topic & Prompt-Based Co-Pilot.

Covers:
1. Search query ``'crypto crash'`` on a 60-minute business podcast verifying
   that ONLY crypto-related segments are returned (>= 94% precision SLA; 100%
   precision in test, even against decoy 'server crash' and 'housing crash'
   segments).
2. 90-minute transcript semantic retrieval latency SLA (<= 4.5 seconds).
3. Conversational directive stripping and intent mode detection
   (``parse_topic_intent``) for natural language prompts and Co-Pilot chips
   ('Actionable Tips', 'Controversial Takes', 'Funny Moments',
   'Key Metrics & Numbers').
4. Exact cosine similarity math and 384-d L2-normalized unit embeddings.
5. 70% semantic shortlist pre-filtering ratio for the LLM reranker.
6. Strict topic floor (``TOPIC_FIT_FLOOR = 7`` / ``0.70`` normalized) hard-drop
   behavior and structured drop-reason logging in ``rerank.py`` and
   ``processors/highlights.py``.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np
import pytest

from worker_ai.highlights.rerank import (
    TOPIC_FIT_FLOOR,
    TOPIC_FIT_SCORE_FLOOR,
    Judged,
    passes_topic_floor,
    system_prompt,
)
from worker_ai.highlights.scoring import Score
from worker_ai.highlights.topic_search import (
    EMBEDDING_DIM,
    SEMANTIC_PREFILTER_RATIO,
    SEMANTIC_SIMILARITY_FLOOR,
    cosine_similarity,
    embed_text,
    embed_units,
    parse_topic_intent,
    prefilter_candidates_for_topic,
    score_windows_for_topic,
)
from worker_ai.highlights.windows import (
    Window,
    build_units,
    enumerate_windows,
    usable_words,
)
from worker_ai.llm.providers.base import LlmRequest
from worker_ai.processors.highlights import (
    _Candidate,
    _rank_with_model,
    discover,
)

from .fake_llm import FakeLlm, moment_blocks
from .test_highlights import options, talk
from .test_highlights_rerank import run_with

# ---------------------------------------------------------------------------
# 60-Minute Business Podcast Fixture Builder
# ---------------------------------------------------------------------------

_PODCAST_TOPICS_NON_CRYPTO: tuple[tuple[str, ...], ...] = (
    (
        "Did you know that hiring senior backend engineers takes three months on average?",
        "We restructured our technical interview loop to focus on real debugging exercises.",
        "That single change improved our engineering retention rate to ninety two percent.",
    ),
    (
        "Why do most enterprise sales teams miss their third quarter pipeline targets?",
        "They spend too much time chasing unqualified leads instead of enterprise accounts.",
        "Focusing on account based outbound doubled our annual contract value within six months.",
    ),
    (
        "Here is the truth about our database server crash during Black Friday traffic.",
        "The primary read replica ran out of connection pools when traffic spiked tenfold.",
        "We added connection pooling and automated failover so the server never crashed again.",
    ),
    (
        "Looking back at the two thousand eight housing market crash and mortgage crisis.",
        "Commercial real estate values plummeted when regional banks froze credit lines.",
        "Homeowners waited nearly five years for suburban property prices to recover.",
    ),
    (
        "How do you lower customer acquisition cost when paid social ads get expensive?",
        "We shifted sixty percent of our marketing budget into organic creator partnerships.",
        "Our customer acquisition payback period dropped from fourteen months down to five months.",
    ),
    (
        "When we raised our seed fundraising round from venture capital investors in Bangalore.",
        "We kept our pitch deck to twelve slides focused purely on net revenue retention.",
        "Founders who obsess over valuation instead of partner conviction regret it later.",
    ),
    (
        "Remote work versus office culture is still the biggest management debate in tech.",
        "We run a hybrid schedule where product squads meet twice a week for design sprints.",
        "Clear written documentation matters far more than sitting in the same building.",
    ),
    (
        "Subscription pricing margins improve dramatically when you bundle annual tiers.",
        "Upfront annual billing gave us the cash flow to fund our entire research team.",
        "Never underprice mission critical workflow software for business customers.",
    ),
)

_CRYPTO_CRASH_SEGMENTS: tuple[tuple[str, ...], ...] = (
    (
        "Why did the crypto crash wipe out two trillion dollars of market value so fast?",
        (
            "When Bitcoin and Ethereum plummeted sixty five percent, overleveraged crypto "
            "exchanges collapsed overnight."
        ),
        (
            "The biggest lesson from that crypto crash is never keeping treasury reserves "
            "in volatile tokens."
        ),
    ),
    (
        (
            "During the crypto crash, algorithmic stablecoins lost their peg and triggered "
            "massive DeFi liquidations."
        ),
        (
            "Solana and altcoin liquidity vanished within forty eight hours as panic spread "
            "across Web3."
        ),
        (
            "Only blockchain infrastructure teams with real fiat runway survived that brutal "
            "crypto meltdown."
        ),
    ),
    (
        (
            "Did you see what happened to institutional crypto funds when the Bitcoin crash "
            "accelerated?"
        ),
        (
            "Contagion spread from centralized crypto lenders to every token treasury on the "
            "blockchain."
        ),
        (
            "Audited proof of reserves is the only way cryptocurrency exchanges will rebuild "
            "trust after the crash."
        ),
    ),
)


def _build_podcast_words(duration_minutes: int = 60) -> list[dict[str, Any]]:
    """Build a timed multi-topic business podcast transcript spanning ``duration_minutes``.

    Each sentence advances the clock by ~12 seconds (5 sentences per minute).
    Three distinct segments across the 60-minute timeline discuss the ``crypto crash``;
    the remaining ~57 minutes cover SaaS, hiring, server crashes, housing crashes,
    customer acquisition cost, and fundraising.
    """
    words: list[dict[str, Any]] = []
    clock_ms = 0
    wid = 0

    def append_sentence(sentence: str, gap_after_ms: int = 900) -> None:
        nonlocal clock_ms, wid
        tokens = sentence.split()
        if not tokens:
            return
        # ~10.5 seconds of speech + gap_after_ms ≈ 11.5-12s per sentence
        word_ms = max(280, 10_500 // len(tokens))
        for token in tokens:
            wid += 1
            words.append(
                {
                    "wid": f"w{wid:05d}",
                    "text": token,
                    "startMs": clock_ms,
                    "endMs": clock_ms + word_ms - 30,
                    "chunkIdx": 0,
                }
            )
            clock_ms += word_ms
        clock_ms += gap_after_ms

    target_ms = duration_minutes * 60 * 1_000
    # Inject the 3 crypto crash segments around minute 12, minute 31, and minute 49
    crypto_schedule_ms = {
        int(target_ms * 0.20): _CRYPTO_CRASH_SEGMENTS[0],
        int(target_ms * 0.52): _CRYPTO_CRASH_SEGMENTS[1],
        int(target_ms * 0.82): _CRYPTO_CRASH_SEGMENTS[2],
    }
    used_crypto: set[int] = set()
    block_idx = 0

    while clock_ms < target_ms:
        injected = False
        for trigger_ms, crypto_block in crypto_schedule_ms.items():
            if trigger_ms not in used_crypto and clock_ms >= trigger_ms:
                used_crypto.add(trigger_ms)
                for line in crypto_block:
                    append_sentence(line, gap_after_ms=1_100)
                injected = True
                break
        if not injected:
            block = _PODCAST_TOPICS_NON_CRYPTO[block_idx % len(_PODCAST_TOPICS_NON_CRYPTO)]
            block_idx += 1
            for line in block:
                append_sentence(line, gap_after_ms=950)

    return words


_CRYPTO_KEYWORDS = frozenset(
    {
        "crypto",
        "cryptocurrency",
        "bitcoin",
        "ethereum",
        "stablecoins",
        "defi",
        "solana",
        "blockchain",
        "web3",
        "token",
        "tokens",
    }
)


def _is_crypto_excerpt(excerpt: str) -> bool:
    lower = excerpt.lower()
    return any(term in lower for term in _CRYPTO_KEYWORDS)


# ---------------------------------------------------------------------------
# 1. 60-Minute Business Podcast 'crypto crash' Precision Test
# ---------------------------------------------------------------------------


def test_crypto_crash_query_on_60_minute_business_podcast_returns_only_crypto_segments() -> None:
    """Search query 'crypto crash' on a 60-minute business podcast returns ONLY crypto segments."""
    podcast_words = _build_podcast_words(duration_minutes=60)
    last_end_ms = podcast_words[-1]["endMs"]
    assert last_end_ms >= 60 * 60 * 1_000

    proposals, windows_considered = discover(
        podcast_words,
        options(count=5, topic="crypto crash"),
        duration_ms=last_end_ms,
    )

    assert windows_considered > 100
    assert len(proposals) >= 2
    for proposal in proposals:
        assert _is_crypto_excerpt(proposal.transcript_excerpt), (
            f"Expected ONLY crypto-related segment for query 'crypto crash', "
            f"got: {proposal.transcript_excerpt!r}"
        )
        # Ensure decoy 'server crash' and 'housing market crash' segments were rejected
        assert "database server" not in proposal.transcript_excerpt.lower()
        assert "housing market" not in proposal.transcript_excerpt.lower()
        assert any(
            reason.label == "clear_point" and "crypto crash" in reason.explanation.lower()
            for reason in proposal.reasons
        )


async def test_crypto_crash_query_with_llm_reranker_returns_only_crypto_segments() -> None:
    """End-to-end process_highlights with LLM reranker for 'crypto crash' on 60-min podcast."""
    podcast_words = _build_podcast_words(duration_minutes=60)

    def judge_crypto(request: LlmRequest) -> Any:
        moments = []
        for window_id, text in moment_blocks(request).items():
            is_crypto = _is_crypto_excerpt(text)
            moments.append(
                {
                    "id": window_id,
                    "standalone": 9 if is_crypto else 8,
                    "payoff": 9 if is_crypto else 8,
                    "humour": 0,
                    "hook": 9 if is_crypto else 8,
                    "trend": 9 if is_crypto else 6,
                    # Decoy segments get topicFit=5 or 6 (below strict floor 7)
                    "topicFit": 9 if is_crypto else 5,
                    "reelViable": True,
                    "why": (
                        "Directly explains the crypto crash and exchange collapse."
                        if is_crypto
                        else "Discusses general business metrics unrelated to crypto."
                    ),
                }
            )
        return {"moments": moments}

    outcome = await run_with(
        (FakeLlm(judge_crypto),),
        podcast_words,
        count=3,
        topic="crypto crash",
    )
    proposals = outcome.result["proposals"]
    assert len(proposals) == 3
    for proposal in proposals:
        assert _is_crypto_excerpt(proposal["transcriptExcerpt"])
        assert proposal["judgement"]["topicFit"] >= TOPIC_FIT_FLOOR


# ---------------------------------------------------------------------------
# 2. 90-Minute Transcript Retrieval Latency SLA (<= 4.5s)
# ---------------------------------------------------------------------------


def test_semantic_retrieval_latency_over_90_minute_transcript_within_sla() -> None:
    """Semantic vector indexing and window scoring on a 90-min transcript completes in <= 4.5s."""
    raw_words = _build_podcast_words(duration_minutes=90)
    words = usable_words(raw_words)
    units = build_units(words, min_ms=15_000, max_ms=60_000)
    windows = enumerate_windows(units, min_ms=15_000, max_ms=60_000, words=words)

    assert raw_words[-1]["endMs"] >= 90 * 60 * 1_000
    assert len(windows) >= 200

    start_time = time.perf_counter()
    matches = score_windows_for_topic(
        "Find moments explaining the crypto crash and token liquidations",
        units,
        words,
        windows,
    )
    elapsed_s = time.perf_counter() - start_time

    assert elapsed_s <= 4.5, f"Expected <= 4.5s SLA on 90-min transcript, took {elapsed_s:.3f}s"
    assert len(matches) == len(windows)
    top_matches = sorted(matches.values(), key=lambda m: -m.combined_score)[:3]
    assert all(m.combined_score >= SEMANTIC_SIMILARITY_FLOOR for m in top_matches)


# ---------------------------------------------------------------------------
# 3. Natural Language Directive Stripping & Intent Parsing
# ---------------------------------------------------------------------------


def test_parse_topic_intent_strips_conversational_wrappers() -> None:
    intent = parse_topic_intent(
        "Find moments explaining customer acquisition cost"
    )
    assert intent.core_query == "customer acquisition cost"
    assert "find" not in intent.query_tokens
    assert "moments" not in intent.query_tokens
    assert "explaining" not in intent.query_tokens
    assert intent.query_tokens == ("customer", "acquisition", "cost")

    intent_seed = parse_topic_intent(
        "Extract every moment where the guest talks about seed fundraising"
    )
    assert intent_seed.core_query == "seed fundraising"
    assert intent_seed.subject_concept_ids  # matches fundraising subject cluster


@pytest.mark.parametrize(
    ("chip_prompt", "expected_mode"),
    [
        ("Actionable Tips", "actionable"),
        ("Controversial Takes", "controversial"),
        ("Funny Moments", "humour"),
        ("Key Metrics & Numbers", "metrics"),
        ("Show me funny moments or bloopers", "humour"),
    ],
)
def test_parse_topic_intent_recognizes_suggestion_chips(
    chip_prompt: str, expected_mode: str
) -> None:
    intent = parse_topic_intent(chip_prompt)
    assert intent.intent_mode == expected_mode
    assert intent.concept_ids


# ---------------------------------------------------------------------------
# 4. Dense Embedding & Cosine Similarity Math
# ---------------------------------------------------------------------------


def test_dense_embedding_dimensions_and_cosine_similarity_math() -> None:
    vec_query = embed_text("crypto crash", is_query=True)
    vec_synonym = embed_text(
        "Bitcoin plummeted and cryptocurrency exchanges collapsed during the token meltdown"
    )
    vec_unrelated = embed_text(
        "We scheduled our weekly design sprint for Tuesday morning in the office"
    )

    assert vec_query.shape == (EMBEDDING_DIM,)
    assert float(np.linalg.norm(vec_query)) == pytest.approx(1.0, rel=1e-5)
    assert cosine_similarity(vec_query, vec_query) == pytest.approx(1.0, rel=1e-5)
    assert cosine_similarity(vec_query, np.zeros(EMBEDDING_DIM, dtype=np.float32)) == 0.0

    sim_on_topic = cosine_similarity(vec_query, vec_synonym)
    sim_off_topic = cosine_similarity(vec_query, vec_unrelated)
    assert sim_on_topic > 0.35
    assert sim_on_topic > sim_off_topic + 0.25


def test_embed_units_produces_normalized_matrix() -> None:
    raw = talk(
        [
            "Bitcoin and Ethereum crashed sixty percent during the exchange meltdown.",
            "Our engineering team shipped the new onboarding workflow yesterday.",
        ]
    )
    words = usable_words(raw)
    units = build_units(words, min_ms=10_000, max_ms=50_000)
    matrix = embed_units(units, words)
    assert matrix.shape == (len(units), EMBEDDING_DIM)
    norms = np.linalg.norm(matrix, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


# ---------------------------------------------------------------------------
# 5. 70% Semantic Shortlist Pre-Filtering Ratio
# ---------------------------------------------------------------------------


def test_prefilter_candidates_for_topic_enforces_70_percent_semantic_ratio() -> None:
    podcast_words = _build_podcast_words(duration_minutes=60)
    words = usable_words(podcast_words)
    units = build_units(words, min_ms=15_000, max_ms=60_000)
    windows = enumerate_windows(units, min_ms=15_000, max_ms=60_000, words=words)

    candidates = [
        _Candidate(w, None, Score(0.65, 0.7, 0.7, 0.5, 0.5, 0.7, 0.5, 0.6, 0.7))  # type: ignore[arg-type]
        for w in windows
    ]
    shortlist_count = 8
    shortlist = prefilter_candidates_for_topic(
        candidates,
        topic="Find moments explaining customer acquisition cost and marketing payback",
        units=units,
        words=words,
        window_of=lambda c: c.window,
        score_of=lambda c: c.score.potential,
        count=shortlist_count,
        timeline=(words[0].start_ms, words[-1].end_ms),
    )

    assert len(shortlist) == shortlist_count
    matches = score_windows_for_topic(
        "Find moments explaining customer acquisition cost and marketing payback",
        units,
        words,
        [c.window for c in shortlist],
    )
    high_sim_count = sum(
        1
        for c in shortlist
        if matches[c.window.window_id].combined_score >= SEMANTIC_SIMILARITY_FLOOR
    )
    assert high_sim_count / len(shortlist) >= SEMANTIC_PREFILTER_RATIO


# ---------------------------------------------------------------------------
# 6. Strict Topic Floor (TOPIC_FIT_FLOOR = 7 / 0.70) & Drop Logging
# ---------------------------------------------------------------------------


def test_passes_topic_floor_validates_both_10_point_and_normalized_scales() -> None:
    assert TOPIC_FIT_FLOOR == 7
    assert pytest.approx(0.70) == TOPIC_FIT_SCORE_FLOOR
    assert passes_topic_floor(None) is False
    assert passes_topic_floor(6) is False
    assert passes_topic_floor(7) is True
    assert passes_topic_floor(10) is True
    assert passes_topic_floor(0.69) is False
    assert passes_topic_floor(0.70) is True
    assert passes_topic_floor(0.95) is True
    assert "dropped below 7" in system_prompt(with_topic=True)


def test_rank_with_model_hard_drops_candidates_below_topic_floor_and_logs_reason(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def make_candidate(wid: str, start_ms: int) -> _Candidate:
        win = Window(window_id=wid, first=0, last=0, start_ms=start_ms, end_ms=start_ms + 20_000)
        return _Candidate(win, None, Score(0.8, 0.8, 0.8, 0.5, 0.5, 0.8, 0.5, 0.7, 0.8))  # type: ignore[arg-type]

    shortlist = [
        make_candidate("w-on-topic", 0),
        make_candidate("w-tangential-6", 30_000),
        make_candidate("w-off-topic-2", 60_000),
    ]
    judged = {
        "w-on-topic": Judged(
            standalone=8,
            payoff=8,
            humour=1,
            topic_fit=9,
            why="Directly explains crypto crash.",
            model="test-llm",
            hook=8,
            reel_viable=True,
        ),
        "w-tangential-6": Judged(
            standalone=9,
            payoff=9,
            humour=2,
            topic_fit=6,  # Below TOPIC_FIT_FLOOR (7) -> must be hard-dropped
            why="Tangential mention only.",
            model="test-llm",
            hook=9,
            reel_viable=True,
        ),
        "w-off-topic-2": Judged(
            standalone=8,
            payoff=8,
            humour=0,
            topic_fit=2,  # Below TOPIC_FIT_FLOOR (7) -> must be hard-dropped
            why="Unrelated subject.",
            model="test-llm",
            hook=8,
            reel_viable=True,
        ),
    }

    with caplog.at_level(logging.INFO):
        ranked = _rank_with_model(
            shortlist,
            judged,
            frozenset(judged.keys()),
            options(count=3, topic="crypto crash"),
        )

    assert [r.candidate.window.window_id for r in ranked] == ["w-on-topic"]
    dropped_logs = [
        rec
        for rec in caplog.records
        if "dropping off-topic candidate below strict topic_fit floor" in rec.getMessage()
    ]
    assert len(dropped_logs) == 2
