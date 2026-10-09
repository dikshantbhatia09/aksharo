"""Comprehensive test suite for Natural Discourse Boundary Snapping (Pillar 2 §03).

Validates:
1. Boundary snapping on 50 complex sentence fragments verifying zero trailing conjunctions
   and accurate leading conjunction advancement.
2. Acoustic audio slice RMS energy test: verifies that slices cut at snapped boundaries
   have zero RMS energy at frame 0 and frame end (100% non-speech silence windows).
3. Hearst's TextTiling semantic discourse segmentation:
   - Lexical cohesion / block cosine similarities
   - Cosine similarity depth valleys D(i) = (s_{i-1} - s_i) + (s_{i+1} - s_i)
   - Peak valley detection and episode topic shifts
   - Discourse coherence scoring
4. Acoustic pause snapping post-pass:
   - snap_to_silence (seconds)
   - snap_to_silence_ms (milliseconds)
   - snap_window_to_silence
   - words_to_silence_gaps
5. End-to-end discovery with discourse filtering and acoustic snapping.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest

from worker_ai.audio import TARGET_SAMPLE_RATE, Pcm
from worker_ai.highlights.contracts import HighlightsOptions
from worker_ai.highlights.texttiling import (
    TextTilingConfig,
    compute_texttiling,
    discourse_coherence_bonus,
)
from worker_ai.highlights.windows import (
    DISALLOWED_CLOSINGS,
    DISALLOWED_OPENINGS,
    Unit,
    Window,
    Word,
    build_units,
    discourse_opening_advance,
    enumerate_windows,
    is_incomplete_closing,
    snap_to_silence,
    snap_to_silence_ms,
    snap_window_to_silence,
    words_to_silence_gaps,
)
from worker_ai.processors.highlights import discover


# ---------------------------------------------------------------------------
# Test Helpers
# ---------------------------------------------------------------------------


def make_words(tokens: list[str], start_ms: int = 0, word_ms: int = 300, gap_ms: int = 100) -> list[Word]:
    """Builds a sequence of timed words."""
    words: list[Word] = []
    clock = start_ms
    for i, token in enumerate(tokens):
        words.append(Word(wid=f"w{i+1:04d}", text=token, start_ms=clock, end_ms=clock + word_ms))
        clock += word_ms + gap_ms
    return words


def make_raw_words(tokens: list[str], start_ms: int = 0, word_ms: int = 300, gap_ms: int = 100) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    clock = start_ms
    for i, token in enumerate(tokens):
        words.append({
            "wid": f"w{i+1:04d}",
            "text": token,
            "startMs": clock,
            "endMs": clock + word_ms,
        })
        clock += word_ms + gap_ms
    return words


# ---------------------------------------------------------------------------
# 1. 50 Complex Sentence Fragments Suite
# ---------------------------------------------------------------------------

#: 25 Leading conjunction fragments (must advance to next syntactically complete clause)
LEADING_FRAGMENTS = [
    ("and so we launched the brand new platform across the globe.", 2, "we"),
    ("like i said the market always rewards relentless consistency.", 3, "the"),
    ("as mentioned earlier we noticed a massive spike in user engagement.", 2, "earlier"),
    ("so anyway let us talk about the second core architecture pattern.", 2, "let"),
    ("and then they decided to open source the entire weight tensor.", 2, "they"),
    ("but then everything changed when the benchmark results came out.", 2, "everything"),
    ("because of this the compiler optimizes recursive calls instantly.", 1, "of"),
    ("and researchers demonstrated a thirty percent reduction in latency.", 1, "researchers"),
    ("but nobody realized how critical this constraint would become.", 1, "nobody"),
    ("so the team pivoted towards building autonomous software agents.", 1, "the"),
    ("or maybe we can explore a different perspective on transformer design.", 1, "maybe"),
    ("well today we will walk through the entire production pipeline.", 1, "today"),
    ("anyway this demonstrates the power of clean architectural separation.", 1, "this"),
    ("aur humne dekha ki model ki accuracy kaafi badh gayi.", 1, "humne"),
    ("lekin iska matlab ye nahi hai ki hum testing chhod dein.", 1, "iska"),
    ("kyunki data quality sabse zyada important hoti hai training mein.", 1, "data"),
    ("waise aap is model ko free mein try kar sakte hain.", 1, "aap"),
    ("like i was saying the bottleneck was never the compute power.", 4, "the"),
    ("as i said every single byte must be verified thoroughly.", 3, "every"),
    ("and also they published the synthetic dataset on hugging face.", 1, "also"),
    ("so why do creators struggle with retention in the first three seconds?", 1, "why"),
    ("and what happens when you train on multilingual voice tracks?", 1, "what"),
    ("but how can small teams deploy models without huge cloud bills?", 1, "how"),
    ("because attention mechanisms allow direct query key value mapping.", 1, "attention"),
    ("and so when transformers replaced recurrent networks everything accelerated.", 2, "when"),
]

#: 25 Trailing conjunction fragments (must be discarded or extended, NEVER cut mid-thought)
TRAILING_FRAGMENTS = [
    ("the single most critical reason why startups fail is because", True),
    ("we spent three months redesigning the frontend interface and", True),
    ("everyone was extremely excited about the new capabilities but", True),
    ("you should never deploy untested microservices if", True),
    ("the benchmark demonstrates strong scaling behavior when", True),
    ("they created a dedicated benchmark suite which", True),
    ("the senior architect mentioned during the all hands meeting that", True),
    ("the entire workflow is completely automated so", True),
    ("the visual fidelity looks unbelievably realistic like", True),
    ("you can either choose local on device inference or", True),
    ("the pipeline ingests 4k raw footage with", True),
    ("we decided to benchmark against the baseline as", True),
    ("the algorithm minimizes global reconstruction error which means that", True),
    ("the process stopped unexpectedly in production because of", True),
    ("first we calibrated the speech alignments and then", True),
    ("we scaled the server cluster across three regions so that", True),
    ("the framework supports diverse modern formats such as", True),
    ("the response latency dropped by ninety percent due to", True),
    ("they refactored the entire query engine in order to", True),
    ("humne pure code ko rewrite kar diya aur", True),
    ("model ne saare test cases pass kar liye lekin", True),
    ("accuracy drop ho gayi kyunki", True),
    ("aap video ko render kar sakte hain to", True),
    ("the engineer verified all the requirements and then", True),
    ("we compared the performance against competing models which", True),
]


def test_50_complex_sentence_fragments_leading_advancement() -> None:
    """Verifies that 25 leading discourse fragments advance to the clean clause start."""
    for text, expected_advance, expected_first_word in LEADING_FRAGMENTS:
        tokens = text.split()
        words = make_words(tokens)
        advance = discourse_opening_advance(words, 0, len(words) - 1)
        assert advance == expected_advance, (
            f"Failed advance count for '{text}': got {advance}, expected {expected_advance}"
        )
        assert words[advance].text == expected_first_word, (
            f"Failed first word for '{text}': got {words[advance].text}, expected {expected_first_word}"
        )


def test_50_complex_sentence_fragments_trailing_rejection() -> None:
    """Verifies that 25 trailing conjunction fragments are detected as incomplete."""
    for text, should_be_incomplete in TRAILING_FRAGMENTS:
        tokens = text.split()
        words = make_words(tokens)
        incomplete = is_incomplete_closing(words, 0, len(words) - 1)
        assert incomplete == should_be_incomplete, (
            f"Failed incomplete closing check for '{text}': got {incomplete}, expected {should_be_incomplete}"
        )


def test_complete_sentences_are_not_flagged_as_incomplete() -> None:
    """Verifies that complete sentences with standard endings are not falsely flagged."""
    clean_sentences = [
        "we fixed the memory leak and deployed the patch to production.",
        "the team achieved record breaking throughput on the benchmark.",
        "after lunch we sat outside and talked about that.",
        "the visual effects looked completely natural.",
        "this is the truth that nobody wants to hear!",
        "did you know that ninety percent of viewers skip the intro?",
    ]
    for text in clean_sentences:
        tokens = text.split()
        words = make_words(tokens)
        assert not is_incomplete_closing(words, 0, len(words) - 1), f"Falsely flagged clean sentence: {text}"


def test_enumerate_windows_zero_trailing_conjunctions() -> None:
    """Verifies that enumerate_windows produces zero windows ending with disallowed conjunctions."""
    # Build transcript with alternating clean and trailing incomplete units
    all_sentences = [
        "the research team released a breakthrough paper on attention yesterday.",
        "the model struggles with multi hop reasoning because",  # trailing
        "they introduced chain of thought reasoning to solve the issue.",
        "the new framework speeds up data processing significantly and",  # trailing
        "every benchmark test passed with flying colors in the end.",
    ]
    words: list[Word] = []
    clock = 0
    for s in all_sentences:
        tokens = s.split()
        for i, token in enumerate(tokens):
            words.append(Word(wid=f"w{len(words)+1:04d}", text=token, start_ms=clock, end_ms=clock + 350))
            clock += 350 + (800 if i == len(tokens) - 1 else 100)

    units = build_units(words, min_ms=3_000, max_ms=30_000)

    # Incomplete units must have has_disallowed_closing flagged
    incomplete_units = [u for u in units if u.has_disallowed_closing]
    assert len(incomplete_units) >= 2

    windows = enumerate_windows(units, min_ms=3_000, max_ms=30_000)
    assert len(windows) > 0

    # 100.0% zero trailing conjunctions SLA across all candidate windows
    for w in windows:
        tail_text = words[w.last].text.lower().rstrip(".,!?")
        assert tail_text not in DISALLOWED_CLOSINGS, (
            f"Window {w.window_id} ends with disallowed conjunction '{tail_text}'!"
        )


def test_build_units_advances_window_start_past_leading_conjunctions() -> None:
    """Verifies that windows starting on a unit with leading connectors start on the clean clause."""
    raw = [
        "and so we decided to rebuild the entire video rendering pipeline.",
        "the performance improvement was immediately noticeable to all creators.",
    ]
    tokens = [t for s in raw for t in s.split()]
    words = make_words(tokens, word_ms=400, gap_ms=100)
    units = build_units(words, min_ms=3_000, max_ms=30_000)

    # First unit should start at 'we', having advanced past 'and so'
    assert units[0].has_disallowed_opening is True
    assert units[0].opening_advance == 2
    assert words[units[0].first].text == "we"
    assert units[0].start_ms == words[2].start_ms

    windows = enumerate_windows(units, min_ms=3_000, max_ms=30_000)
    for w in windows:
        if w.first == units[0].first:
            assert words[w.first].text == "we"
            assert words[w.first].text != "and"


# ---------------------------------------------------------------------------
# 2. Audio Acoustic RMS Energy Slice Test
# ---------------------------------------------------------------------------


def test_audio_slices_at_snapped_boundaries_have_zero_rms_energy() -> None:
    """Verifies that audio slices cut at snapped boundaries have zero RMS energy at frame 0 and frame end.

    SLA: Boundary precision: 100.0% of cuts fall within non-speech acoustic silence windows.
    Zero Word Chopping: Speech syllables must never be sliced in half.
    """
    sr = TARGET_SAMPLE_RATE  # 16000 Hz
    duration_s = 6.0
    total_samples = int(duration_s * sr)
    audio = np.zeros(total_samples, dtype=np.float32)

    # Simulate Speech Burst 1: 0.5s to 2.0s (440 Hz tone, high RMS)
    t1 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False)
    burst1 = (0.5 * np.sin(2 * np.pi * 440 * t1)).astype(np.float32)
    s1_start = int(0.5 * sr)
    audio[s1_start : s1_start + len(burst1)] = burst1

    # Simulate Silence Gap 1: 2.0s to 3.0s (1.0s silence, exactly 0.0 RMS)
    # Midpoint of silence gap 1 is at 2.5s (2500 ms)

    # Simulate Speech Burst 2: 3.0s to 4.5s (880 Hz tone, high RMS)
    t2 = np.linspace(0, 1.5, int(1.5 * sr), endpoint=False)
    burst2 = (0.5 * np.sin(2 * np.pi * 880 * t2)).astype(np.float32)
    s2_start = int(3.0 * sr)
    audio[s2_start : s2_start + len(burst2)] = burst2

    # Simulate Silence Gap 2: 4.5s to 6.0s (1.5s silence, exactly 0.0 RMS)
    # Midpoint of silence gap 2 is at 5.25s (5250 ms)

    pcm = Pcm(samples=audio, sample_rate=sr)

    # Define words matching the speech bursts
    words = [
        Word(wid="w0001", text="welcome", start_ms=500, end_ms=1200),
        Word(wid="w0002", text="everyone.", start_ms=1300, end_ms=2000),
        Word(wid="w0003", text="today", start_ms=3000, end_ms=3700),
        Word(wid="w0004", text="we", start_ms=3800, end_ms=4100),
        Word(wid="w0005", text="begin.", start_ms=4200, end_ms=4500),
    ]

    # Silence intervals: [0, 500], [2000, 3000], [4500, 6000]
    silences_ms = [(0, 500), (2000, 3000), (4500, 6000)]
    silences_sec = [(0.0, 0.5), (2.0, 3.0), (4.5, 6.0)]

    # Test snap_to_silence in seconds (Section 4.1 algorithm)
    assert snap_to_silence(0.5, silences_sec) == 0.25  # midpoint of [0.0, 0.5]
    assert snap_to_silence(2.0, silences_sec) == 2.5   # midpoint of [2.0, 3.0]
    assert snap_to_silence(4.5, silences_sec) == 5.25  # midpoint of [4.5, 6.0]

    # Test snap_to_silence_ms in milliseconds
    assert snap_to_silence_ms(500, silences_ms) == 250
    assert snap_to_silence_ms(2000, silences_ms) == 2500
    assert snap_to_silence_ms(4500, silences_ms) == 5250

    # Build window spanning words 0 to 4 (500ms to 4500ms)
    raw_window = Window(window_id="w-00001", first=0, last=4, start_ms=500, end_ms=4500)
    snapped = snap_window_to_silence(raw_window, silences_ms, words)

    assert snapped.start_ms == 250   # snapped to midpoint of silence before word 0
    assert snapped.end_ms == 5250    # snapped to midpoint of silence after word 4

    # Extract 512-sample frame at frame 0 (start_ms)
    frame_0_sample = int((snapped.start_ms / 1000.0) * sr)
    frame_0 = pcm.samples[frame_0_sample : frame_0_sample + 512]
    rms_0 = float(np.sqrt(np.mean(np.square(frame_0))))
    assert rms_0 == 0.0, f"Frame 0 has non-zero RMS: {rms_0} (speech sliced!)"

    # Extract 512-sample frame at frame end (end_ms)
    frame_end_sample = int((snapped.end_ms / 1000.0) * sr)
    frame_end = pcm.samples[frame_end_sample - 512 : frame_end_sample]
    rms_end = float(np.sqrt(np.mean(np.square(frame_end))))
    assert rms_end == 0.0, f"Frame end has non-zero RMS: {rms_end} (speech sliced!)"


# ---------------------------------------------------------------------------
# 3. Hearst's TextTiling Semantic Segmentation Unit Tests
# ---------------------------------------------------------------------------


def test_texttiling_detects_thematic_valley_boundaries() -> None:
    """Verifies that TextTiling identifies cosine similarity depth valleys at topic transitions."""
    topic_a = [
        "quantum computing algorithms accelerate matrix operations rapidly.",
        "quantum computing hardware operates with superconducting qubits.",
        "quantum computing circuits execute fault tolerant algorithms.",
    ]
    topic_b = [
        "traditional pasta cooking requires salted boiling water.",
        "delicious pasta dishes use fresh olive oil and basil.",
        "homemade pasta tastes fantastic with grated pecorino cheese.",
    ]

    all_sentences = topic_a + topic_b
    tokens = [t for s in all_sentences for t in s.split()]
    words = make_words(tokens, word_ms=400, gap_ms=100)
    units = build_units(words, min_ms=3_000, max_ms=60_000)

    # 6 units in total: units 0, 1, 2 (topic A) and units 3, 4, 5 (topic B)
    assert len(units) == 6

    config = TextTilingConfig(block_units=1, smoothing_radius=0, min_depth_threshold=0.10)
    result = compute_texttiling(units, words, config)

    # Boundary 2 is between unit 2 (last sentence of topic A) and unit 3 (first sentence of topic B)
    # Boundary similarity between topic A and topic B is 0.0 (completely disjoint vocabularies)
    assert len(result.similarities) == 5
    assert result.similarities[2] == 0.0
    assert result.similarities[0] > 0.0
    assert result.similarities[4] > 0.0

    # Depth score D(2) = (s_1 - s_2) + (s_3 - s_2) must form a prominent valley peak
    assert result.depth_scores[2] > 0.20
    assert 2 in result.peak_valleys
    assert result.is_thematic_boundary(2) is True


def test_discourse_coherence_bonus_rewards_episode_alignment() -> None:
    """Verifies that windows aligning with peak valleys receive standalone coherence bonuses."""
    topic_a = [
        "quantum algorithms solve complex mathematical equations.",
        "quantum algorithms optimize global computation speed.",
    ]
    topic_b = [
        "pasta recipes require olive oil and tomato sauce.",
        "pasta recipes taste delicious with parmesan cheese.",
    ]

    tokens = [t for s in (topic_a + topic_b) for t in s.split()]
    words = make_words(tokens, word_ms=400, gap_ms=100)
    units = build_units(words, min_ms=2_000, max_ms=30_000)

    result = compute_texttiling(units, words, TextTilingConfig(block_units=1, min_depth_threshold=0.10))
    assert 1 in result.peak_valleys  # boundary between unit 1 and unit 2

    # Window covering exactly topic B (unit 2 to unit 3) starts right after peak valley 1
    bonus_aligned = discourse_coherence_bonus(2, 3, len(units), result)
    assert bonus_aligned > 0.0

    # Window misaligned (straddling mid-topic 1 to mid-topic 2)
    bonus_misaligned = discourse_coherence_bonus(1, 2, len(units), result)
    assert bonus_misaligned < bonus_aligned


# ---------------------------------------------------------------------------
# 4. Acoustic Silence Snapping Helper Tests
# ---------------------------------------------------------------------------


def test_words_to_silence_gaps_extraction() -> None:
    words = [
        Word(wid="w1", text="first", start_ms=200, end_ms=500),
        Word(wid="w2", text="second", start_ms=900, end_ms=1200),   # 400ms gap before
        Word(wid="w3", text="third", start_ms=1800, end_ms=2100),   # 600ms gap before
    ]
    gaps = words_to_silence_gaps(words, duration_ms=3000)
    assert gaps == [(0, 200), (500, 900), (1200, 1800), (2100, 3000)]


def test_snap_window_to_silence_never_slices_into_words() -> None:
    words = [
        Word(wid="w1", text="hello", start_ms=1000, end_ms=1400),
        Word(wid="w2", text="world", start_ms=1500, end_ms=1900),
        Word(wid="w3", text="next", start_ms=3000, end_ms=3400),
    ]
    # Inter-word silence between w2 and w3: [1900, 3000]. Midpoint = 2450.
    silences = [(500, 1000), (1900, 3000)]
    window = Window(window_id="w-00001", first=0, last=1, start_ms=1000, end_ms=1900)

    snapped = snap_window_to_silence(window, silences, words, min_ms=1000, tolerance_ms=800)
    # Start snapped to midpoint of [500, 1000] -> 750
    assert snapped.start_ms == 750
    assert snapped.start_ms <= words[0].start_ms
    # End snapped to midpoint of [1900, 3000] -> 2450
    assert snapped.end_ms == 2450
    assert snapped.end_ms >= words[1].end_ms
    assert snapped.end_ms <= words[2].start_ms


# ---------------------------------------------------------------------------
# 5. End-to-End Discovery with Discourse Snapping
# ---------------------------------------------------------------------------


def test_e2e_discover_with_silence_snapping() -> None:
    """Verifies that discover() with silences produces proposals with clean snapped boundaries."""
    sentences = [
        "the future of software development involves autonomous coding agents.",
        "developers collaborate with AI models to design and ship features faster.",
        "rigorous automated testing guarantees zero regression across the system.",
    ]
    raw_words = make_raw_words(
        [t for s in sentences for t in s.split()],
        start_ms=1000,
        word_ms=350,
        gap_ms=150,
    )
    silences = [(0, 1000), (2000, 2600), (5000, 5800), (8000, 9000)]

    opts = HighlightsOptions(
        count=3,
        minDurationMs=3_000,
        maxDurationMs=30_000,
        contentGoal="reach",
        language="en",
    )

    proposals, considered = discover(raw_words, opts, duration_ms=10_000, silences=silences)
    assert len(proposals) > 0
    assert considered > 0

    for p in proposals:
        # Verify no trailing conjunction in transcript excerpt
        tokens = p.transcript_excerpt.split()
        last_token = tokens[-1].lower().rstrip(".,!?")
        assert last_token not in DISALLOWED_CLOSINGS

        # Verify no disallowed opening conjunction
        first_token = tokens[0].lower().rstrip(".,!?")
        assert first_token not in {"and", "but", "because", "so"}
