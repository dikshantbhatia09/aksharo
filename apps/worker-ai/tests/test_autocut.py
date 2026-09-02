"""Unit, metric and property tests for `worker_ai.passes.autocut` (B18)."""

from __future__ import annotations

import time
from itertools import pairwise

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from worker_ai.passes.autocut import (
    PADDING_MS,
    PRESETS,
    AutocutInput,
    SpeechRegion,
    Word,
    lexicon_path,
    load_lexicon,
    run_autocut,
)

EN_LEXICON = load_lexicon("en")
HI_LEXICON = load_lexicon("hi")
HINGLISH_LEXICON = load_lexicon("hinglish")

ALL_LANGUAGES = ["en", "hi", "hinglish", "ta", "te", "bn", "mr", "gu", "kn", "ml", "pa", "ur"]


def word(wid: str, s: int, e: int, t: str, **kwargs: object) -> Word:
    return Word(wid=wid, s=s, e=e, t=t, **kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Lexicons
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("language", ALL_LANGUAGES)
def test_every_lexicon_loads_and_has_entries(language: str) -> None:
    assert lexicon_path(language).exists(), f"missing lexicon file for {language}"
    lexicon = load_lexicon(language)
    assert len(lexicon.entries) > 0
    for entry in lexicon.entries:
        assert entry.context_rule in ("always", "isolated_only")
        assert 0.0 < entry.weight <= 1.0


def test_lexicon_matches_case_insensitively() -> None:
    assert EN_LEXICON.match("UM") is not None
    assert EN_LEXICON.match("Um") is not None
    assert EN_LEXICON.match("basically") is not None


def test_hinglish_lexicon_matches_native_script_variant() -> None:
    entry = HINGLISH_LEXICON.match("मतलब")
    assert entry is not None
    assert entry.token == "matlab"


# ---------------------------------------------------------------------------
# Silence detection: precision >= 0.9, recall >= 0.8 (acceptance criterion 1)
# ---------------------------------------------------------------------------


def _silence_fixture() -> tuple[AutocutInput, set[tuple[int, int]]]:
    """Ten speech regions with silences of varying length between them.

    Only the four gaps >= the "standard" preset's 600 ms threshold should be
    detected; the rest are natural short pauses between clauses.
    """
    regions = []
    labelled_gaps: set[tuple[int, int]] = set()
    cursor = 0
    gaps_ms = [200, 700, 150, 900, 300, 1_200, 100, 650, 250, 2_000]
    words = []
    wid = 0
    for _index, gap in enumerate(gaps_ms):
        start = cursor
        end = start + 3_000
        regions.append(SpeechRegion(start_ms=start, end_ms=end))
        for offset in range(0, 3_000, 500):
            words.append(word(f"0:{wid}", start + offset, start + offset + 400, f"word{wid}"))
            wid += 1
        if gap >= 600:
            labelled_gaps.add((end, end + gap))
        cursor = end + gap
    duration_ms = cursor
    return (
        AutocutInput(
            words=tuple(words),
            speech_regions=tuple(regions),
            duration_ms=duration_ms,
            preset="standard",
        ),
        labelled_gaps,
    )


def test_silence_detection_precision_and_recall() -> None:
    autocut_input, labelled_gaps = _silence_fixture()
    result = run_autocut(autocut_input)
    silence_items = [item for item in result.items if item.reason == "silence"]

    def matches_a_label(start: int, end: int) -> bool:
        # Padding trims 80ms off each side, so a detected cut should sit inside
        # (and near) a labelled gap.
        return any(
            gap_start <= start + PADDING_MS + 50 and end - PADDING_MS - 50 <= gap_end
            for gap_start, gap_end in labelled_gaps
        )

    true_positive = sum(1 for item in silence_items if matches_a_label(item.start_ms, item.end_ms))
    precision = true_positive / len(silence_items) if silence_items else 0.0
    recall = true_positive / len(labelled_gaps) if labelled_gaps else 1.0

    assert precision >= 0.9, f"precision {precision} from {silence_items}"
    assert recall >= 0.8, f"recall {recall} from {silence_items} vs {labelled_gaps}"


# ---------------------------------------------------------------------------
# Filler detection: precision >= 0.85, no false positives on isolated-only in
# continuous speech (acceptance criterion 1)
# ---------------------------------------------------------------------------


def _continuous_speech_words() -> list[Word]:
    """"like" and "toh"/"so" used mid-sentence, tightly packed (no isolation)."""
    script = [
        "I", "would", "like", "to", "go", "there",
        "so", "we", "went", "to", "the", "market",
        "toh", "the", "price", "was", "high",
    ]
    words = []
    t = 0
    for index, token in enumerate(script):
        words.append(word(f"0:{index}", t, t + 250, token))
        t += 300  # 50ms gap: well under the 120ms isolation threshold
    return words


def test_isolated_only_fillers_have_no_false_positives_in_continuous_speech() -> None:
    words = _continuous_speech_words()
    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=words[-1].e),),
        duration_ms=words[-1].e,
        preset="standard",
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    filler_items = [item for item in result.items if item.reason == "filler"]
    # "like" and "so" are mid-sentence and tightly spaced: isolated_only guard
    # must suppress them. Only the always-cut fillers would ever fire here, and
    # this fixture has none.
    assert filler_items == []


def test_always_fillers_are_always_cut() -> None:
    words = [
        word("0:0", 0, 300, "so"),
        word("0:1", 400, 700, "um"),
        word("0:2", 800, 1100, "we"),
        word("0:3", 1200, 1500, "began"),
    ]
    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=1500),),
        duration_ms=1500,
        preset="standard",
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    reasons_by_word = {wid: item.reason for item in result.items for wid in item.word_ids}
    assert reasons_by_word.get("0:1") == "filler"


def test_isolated_only_filler_cut_when_flanked_by_pause() -> None:
    words = [
        word("0:0", 0, 300, "we"),
        word("0:1", 300, 600, "went"),
        # A clear 400ms pause before AND after "matlab" isolates it.
        word("0:2", 1000, 1300, "matlab"),
        word("0:3", 1700, 2000, "there"),
    ]
    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=2000),),
        duration_ms=5000,  # kept large so the surrounding pauses aren't also cut as silence
        preset="tight",
        min_silence_ms=100_000,  # disable silence/pause detectors for this isolated test
        lexicon=HINGLISH_LEXICON,
    )
    result = run_autocut(autocut_input)
    filler_wids = {wid for item in result.items if item.reason == "filler" for wid in item.word_ids}
    assert "0:2" in filler_wids


def test_filler_precision_at_least_0_85() -> None:
    """A mixed script: 20 true fillers, some isolated some not, plus 30 real words
    that happen to share tokens with `isolated_only` entries but are never
    isolated. Precision over all proposed filler cuts must be >= 0.85.
    """
    words: list[Word] = []
    t = 0
    true_filler_ids: set[str] = set()
    idx = 0

    def add(token: str, gap_before: int = 60, is_filler: bool = False) -> None:
        nonlocal t, idx
        t += gap_before
        wid = f"0:{idx}"
        words.append(word(wid, t, t + 250, token))
        if is_filler:
            true_filler_ids.add(wid)
        t += 250
        idx += 1

    # 20 unambiguous "always" fillers, tightly packed among real words.
    for _ in range(20):
        add("hello")
        add("um", is_filler=True)
        add("world")

    # 30 "isolated_only" tokens used as real words, never isolated (tight gaps).
    for _ in range(30):
        add("so")
        add("we")
        add("continue")

    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=t),),
        duration_ms=t,
        preset="standard",
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    filler_items = [item for item in result.items if item.reason == "filler"]
    proposed_ids = {wid for item in filler_items for wid in item.word_ids}
    true_positive = len(proposed_ids & true_filler_ids)
    precision = true_positive / len(proposed_ids) if proposed_ids else 0.0
    assert precision >= 0.85, (
        f"precision {precision}, proposed={proposed_ids}, true={true_filler_ids}"
    )
    assert true_filler_ids <= proposed_ids  # every "um" was found


# ---------------------------------------------------------------------------
# Retake detection
# ---------------------------------------------------------------------------


def test_retake_detection_keeps_the_last_take() -> None:
    take_one = ["so", "today", "we", "are", "going", "to", "talk", "about", "the", "new", "feature"]
    take_two = f"{" ".join(take_one)} launch".split()

    words: list[Word] = []
    t = 0
    idx = 0
    for token in take_one:
        words.append(word(f"0:{idx}", t, t + 300, token))
        t += 320
        idx += 1
    t += 1_000  # a breath between takes, well inside the 20s retake window
    take_two_ids = []
    for token in take_two:
        wid = f"0:{idx}"
        words.append(word(wid, t, t + 300, token))
        take_two_ids.append(wid)
        t += 320
        idx += 1

    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=t),),
        duration_ms=t,
        preset="tight",
        min_silence_ms=100_000,  # isolate retake detection from silence/pause
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    retake_items = [item for item in result.items if item.reason == "retake"]
    assert len(retake_items) == 1
    cut_ids = set(retake_items[0].word_ids)
    # The FIRST take is cut; none of the second (kept) take's word ids appear.
    assert cut_ids.isdisjoint(take_two_ids)
    assert cut_ids  # something from the first take was flagged


def test_dissimilar_adjacent_sentences_are_not_retakes() -> None:
    sentence_one = ["the", "weather", "today", "is", "lovely", "and", "warm"]
    sentence_two = ["please", "remember", "to", "send", "the", "invoice", "tomorrow"]
    words = []
    t = 0
    for idx, token in enumerate([*sentence_one, *sentence_two]):
        words.append(word(f"0:{idx}", t, t + 300, token))
        t += 320
        if idx + 1 == len(sentence_one):
            t += 500

    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=t),),
        duration_ms=t,
        preset="gentle",
        min_silence_ms=100_000,
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    assert [item for item in result.items if item.reason == "retake"] == []


# ---------------------------------------------------------------------------
# Protection invariants (property tests)
# ---------------------------------------------------------------------------


def _random_transcript(draw: st.DrawFn) -> AutocutInput:
    n_words = draw(st.integers(min_value=2, max_value=40))
    t = 0
    words = []
    for i in range(n_words):
        gap = draw(st.integers(min_value=0, max_value=1_500))
        t += gap
        duration = draw(st.integers(min_value=80, max_value=400))
        token = draw(st.sampled_from(["um", "uh", "like", "so", "hello", "world", "matlab", "toh"]))
        words.append(word(f"0:{i}", t, t + duration, token))
        t += duration

    regions = [SpeechRegion(start_ms=0, end_ms=t)]
    preset = draw(st.sampled_from(list(PRESETS.keys())))

    protected: tuple[tuple[int, int], ...] = ()
    if draw(st.booleans()) and t > 0:
        p_start = draw(st.integers(min_value=0, max_value=t))
        p_end = draw(st.integers(min_value=p_start, max_value=t))
        protected = ((p_start, p_end),)

    return AutocutInput(
        words=tuple(words),
        speech_regions=tuple(regions),
        duration_ms=t,
        preset=preset,
        lexicon=EN_LEXICON,
        protected_ranges=protected,
    )


@given(st.composite(_random_transcript)())
@settings(max_examples=60, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_items_never_overlap(autocut_input: AutocutInput) -> None:
    result = run_autocut(autocut_input)
    ordered = sorted(result.items, key=lambda item: item.start_ms)
    for a, b in pairwise(ordered):
        assert a.end_ms <= b.start_ms, f"overlap: {a} vs {b}"


@given(st.composite(_random_transcript)())
@settings(max_examples=60, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_items_never_cut_inside_a_word(autocut_input: AutocutInput) -> None:
    result = run_autocut(autocut_input)
    for item in result.items:
        for w in autocut_input.words:
            # A cut boundary must never land strictly inside a word's span.
            assert not (w.s < item.start_ms < w.e), f"{item} cuts into {w}"
            assert not (w.s < item.end_ms < w.e), f"{item} cuts into {w}"


@given(st.composite(_random_transcript)())
@settings(max_examples=60, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_items_respect_protected_ranges(autocut_input: AutocutInput) -> None:
    result = run_autocut(autocut_input)
    for item in result.items:
        for p_start, p_end in autocut_input.protected_ranges:
            assert not (item.start_ms < p_end and p_start < item.end_ms), (
                f"{item} overlaps protected range ({p_start}, {p_end})"
            )


@given(st.composite(_random_transcript)())
@settings(max_examples=60, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_items_respect_removal_cap(autocut_input: AutocutInput) -> None:
    result = run_autocut(autocut_input)
    if autocut_input.duration_ms <= 0:
        return
    ratio = result.preset.max_removal_ratio
    # A small slack for the bridging step, which can push slightly over the cap
    # to avoid leaving a kept sliver under 350ms; it never lets removal run away.
    assert result.total_removed_ms <= autocut_input.duration_ms * ratio + MIN_KEPT_SEGMENT_SLACK


MIN_KEPT_SEGMENT_SLACK = 400  # milliseconds, matches MIN_KEPT_SEGMENT_MS + rounding


def test_never_produces_a_kept_segment_under_the_minimum() -> None:
    """Two silences separated by a 200ms sliver of "speech" must bridge into one cut."""
    words = [
        word("0:0", 0, 300, "hello"),
        word("0:1", 1200, 1400, "x"),  # tiny word sitting in the sliver
        word("0:2", 2500, 2800, "world"),
    ]
    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=(
            SpeechRegion(start_ms=0, end_ms=300),
            SpeechRegion(start_ms=1200, end_ms=1400),
            SpeechRegion(start_ms=2500, end_ms=2800),
        ),
        duration_ms=2800,
        preset="tight",
        lexicon=EN_LEXICON,
    )
    result = run_autocut(autocut_input)
    ordered = sorted(result.items, key=lambda item: item.start_ms)
    for a, b in pairwise(ordered):
        assert b.start_ms - a.end_ms >= 350 or b.start_ms - a.end_ms == 0


# ---------------------------------------------------------------------------
# Performance: a 30-minute fixture must run under 60s on CPU (acceptance
# criterion 2). Word density: ~150 wpm is generous for real speech.
# ---------------------------------------------------------------------------


def test_thirty_minute_fixture_runs_under_budget() -> None:
    duration_ms = 30 * 60 * 1000
    words = []
    t = 0
    idx = 0
    tokens = ["so", "um", "we", "went", "there", "and", "matlab", "toh", "it", "was", "great"]
    while t < duration_ms - 500:
        token = tokens[idx % len(tokens)]
        gap = 150 + (idx % 5) * 100
        t += gap
        words.append(word(f"0:{idx}", t, t + 250, token))
        t += 250
        idx += 1

    regions = []
    cursor = 0
    while cursor < duration_ms:
        span = min(20_000, duration_ms - cursor)
        regions.append(SpeechRegion(start_ms=cursor, end_ms=cursor + span - 400))
        cursor += span

    autocut_input = AutocutInput(
        words=tuple(words),
        speech_regions=tuple(regions),
        duration_ms=duration_ms,
        preset="standard",
        lexicon=EN_LEXICON,
    )

    started = time.monotonic()
    result = run_autocut(autocut_input)
    elapsed = time.monotonic() - started

    assert elapsed < 60.0, f"autocut took {elapsed:.2f}s for a 30-minute fixture"
    assert result.items  # sanity: something was detected


# ---------------------------------------------------------------------------
# Preset thresholds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "preset,expected_min_silence,expected_ratio",
    [("gentle", 1_000, 0.15), ("standard", 600, 0.30), ("tight", 400, 0.45)],
)
def test_preset_thresholds_match_the_brief(
    preset: str, expected_min_silence: int, expected_ratio: float
) -> None:
    config = PRESETS[preset]
    assert config.min_silence_ms == expected_min_silence
    assert config.max_removal_ratio == expected_ratio


def test_unknown_preset_falls_back_to_standard() -> None:
    autocut_input = AutocutInput(
        words=(word("0:0", 0, 100, "hi"),),
        speech_regions=(SpeechRegion(start_ms=0, end_ms=100),),
        duration_ms=100,
        preset="does-not-exist",
    )
    assert autocut_input.preset_config().min_silence_ms == PRESETS["standard"].min_silence_ms
