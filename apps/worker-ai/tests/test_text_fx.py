"""``worker_ai.passes.text_fx`` (D06): rate limiting, snapping, classification."""

from __future__ import annotations

from worker_ai.passes.text_fx import (
    MAX_PER_WINDOW,
    MIN_GAP_MS,
    Word,
    build_text_fx_events,
    classify_intent,
)


def _words(count: int, *, step_ms: int = 400, start_ms: int = 0) -> list[Word]:
    words: list[Word] = []
    t = start_ms
    for i in range(count):
        words.append(Word(wid=f"0:{i}", s=t, e=t + step_ms - 20, t=f"word{i}"))
        t += step_ms
    return words


def test_classify_intent_question_is_hook() -> None:
    assert classify_intent("Why does this work?") == "hook"


def test_classify_intent_digit_is_stat() -> None:
    assert classify_intent("10x growth") == "stat"


def test_classify_intent_quote_is_quote() -> None:
    assert classify_intent('"never give up"') == "quote"


def test_classify_intent_default_is_title() -> None:
    assert classify_intent("The big reveal") == "title"


def test_snaps_to_word_boundaries_not_the_llm_guess() -> None:
    words = _words(5, step_ms=1000)  # words at 0-980, 1000-1980, ...
    keyphrases = [{"phrase": "word1", "startMs": 1005, "endMs": 1300}]
    events = build_text_fx_events(keyphrases, words)
    assert len(events) == 1
    # snapped to the covering word's own s/e, not the LLM's 1005/1300 guess.
    assert events[0].start_ms == 1000
    assert events[0].end_ms == 1980
    assert events[0].anchor_word_ids == ("0:1",)


def test_phrase_with_no_covering_word_is_dropped() -> None:
    words = _words(3, step_ms=1000)
    keyphrases = [{"phrase": "nowhere", "startMs": 100_000, "endMs": 100_500}]
    assert build_text_fx_events(keyphrases, words) == []


def test_rate_limit_drops_a_phrase_closer_than_min_gap() -> None:
    words = _words(60, step_ms=1000)  # 0..59000ms
    keyphrases = [
        {"phrase": "first", "startMs": 0, "endMs": 500},
        {"phrase": "second", "startMs": MIN_GAP_MS - 2000, "endMs": MIN_GAP_MS - 1500},
        {"phrase": "third", "startMs": MIN_GAP_MS + 3000, "endMs": MIN_GAP_MS + 3500},
    ]
    events = build_text_fx_events(keyphrases, words)
    texts = [e.text for e in events]
    assert "first" in texts
    assert "second" not in texts  # inside the 20s gap from "first"
    assert "third" in texts


def test_window_cap_drops_the_13th_phrase_in_10_minutes() -> None:
    words = _words(700, step_ms=1000)  # 0..699000ms, one word per second
    keyphrases = [
        {"phrase": f"p{i}", "startMs": i * MIN_GAP_MS, "endMs": i * MIN_GAP_MS + 500}
        for i in range(MAX_PER_WINDOW + 1)
    ]
    events = build_text_fx_events(keyphrases, words)
    assert len(events) == MAX_PER_WINDOW


def test_guarded_range_drops_the_phrase_outright_not_clamped() -> None:
    words = _words(10, step_ms=1000)
    keyphrases = [{"phrase": "protected bit", "startMs": 2000, "endMs": 2500}]
    events = build_text_fx_events(keyphrases, words, guarded_ranges=[(1500, 3500)])
    assert events == []


def test_empty_phrase_text_is_skipped() -> None:
    words = _words(5, step_ms=1000)
    keyphrases = [{"phrase": "   ", "startMs": 0, "endMs": 500}]
    assert build_text_fx_events(keyphrases, words) == []


def test_events_are_chronological_regardless_of_input_order() -> None:
    words = _words(60, step_ms=1000)
    keyphrases = [
        {"phrase": "later", "startMs": 30_000, "endMs": 30_500},
        {"phrase": "earlier", "startMs": 0, "endMs": 500},
    ]
    events = build_text_fx_events(keyphrases, words)
    assert [e.text for e in events] == ["earlier", "later"]


def test_motion_preset_follows_intent() -> None:
    words = _words(10, step_ms=1000)
    keyphrases = [{"phrase": "50 percent faster", "startMs": 0, "endMs": 500}]
    events = build_text_fx_events(keyphrases, words)
    assert events[0].intent == "stat"
    assert events[0].motion_preset == "count-up"
