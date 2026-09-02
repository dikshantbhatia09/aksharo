"""CTC forced alignment (D13, `09 §2`) and the script projections it needs.

The emissions are hand-written matrices rather than a checkpoint: a 1.2 GB
download would make the suite untestable in CI, and the algorithm is the part
that can be wrong. `worker_ai/alignment/ctc.py` takes an injectable ``emitter``
for exactly this.
"""

from __future__ import annotations

from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray

from worker_ai.alignment.ctc import (
    CtcAligner,
    forced_align,
    word_spans,
)
from worker_ai.alignment.indic_wav2vec import IndicWav2VecAligner
from worker_ai.alignment.mms import MmsAligner
from worker_ai.alignment.romanisation import romanise, to_devanagari
from worker_ai.audio import Pcm, write_wav
from worker_ai.providers.base import AlignmentRequest
from worker_ai.vad import SpeechRegion


def emissions(frames: list[int], vocab_size: int, blank: int = 0) -> NDArray[np.float32]:
    """One-hot-ish log-probabilities: ``frames[i]`` is the token frame *i* emitted."""
    matrix = np.full((len(frames), vocab_size), -10.0, dtype=np.float32)
    for index, token in enumerate(frames):
        matrix[index, token] = 0.0
    del blank
    return matrix


# ---------------------------------------------------------------------------
# The Viterbi pass
# ---------------------------------------------------------------------------


def test_each_token_gets_the_frames_it_was_emitted_over() -> None:
    #   frame: 0     1  2  3     4  5
    #   token: <b>   a  a  <b>   b  b
    log_probs = emissions([0, 1, 1, 0, 2, 2], vocab_size=3)
    spans = forced_align(log_probs, [1, 2], blank=0)
    assert [(span.start_frame, span.end_frame) for span in spans] == [(1, 3), (4, 6)]


def test_a_repeated_character_keeps_its_separating_blank() -> None:
    """"ll" without a blank between the copies collapses to one "l"."""
    # l  <b>  l
    log_probs = emissions([1, 0, 1], vocab_size=2)
    spans = forced_align(log_probs, [1, 1], blank=0)
    assert spans[0].start_frame == 0
    assert spans[1].start_frame == 2
    assert spans[0].end_frame <= spans[1].start_frame


def test_no_tokens_means_no_spans() -> None:
    assert forced_align(emissions([0], 2), [], blank=0) == ()


def test_audio_too_short_for_the_text_is_an_error_not_a_silent_zero() -> None:
    with pytest.raises(ValueError, match="cannot align"):
        forced_align(emissions([1], vocab_size=3), [1, 2, 1], blank=0)


def test_spans_are_monotonic_across_a_long_sequence() -> None:
    tokens = [1, 2, 3, 2, 1]
    frames: list[int] = []
    for token in tokens:
        frames.extend([0, token, token])
    spans = forced_align(emissions(frames, vocab_size=4), tokens, blank=0)
    for previous, following in pairwise(spans):
        assert previous.end_frame <= following.end_frame
        assert previous.start_frame <= following.start_frame


def test_word_spans_group_tokens_back_into_words() -> None:
    log_probs = emissions([1, 1, 2, 2, 3, 3], vocab_size=4)
    spans = forced_align(log_probs, [1, 2, 3], blank=0)
    grouped = word_spans(("ab", "c"), spans, (2, 1))
    assert grouped[0][0] == spans[0].start_frame
    assert grouped[0][1] == spans[1].end_frame
    assert grouped[1] == (spans[2].start_frame, spans[2].end_frame)


def test_a_word_with_no_tokens_still_gets_a_span() -> None:
    """The caller indexes by position; a dropped word would shift every timing."""
    spans = forced_align(emissions([1, 1], vocab_size=2), [1], blank=0)
    grouped = word_spans(("a", "​"), spans, (1, 0))
    assert len(grouped) == 2
    assert grouped[1][0] == grouped[1][1]


# ---------------------------------------------------------------------------
# The aligner
# ---------------------------------------------------------------------------


@pytest.fixture
def clip(tmp_path: Path) -> Path:
    """One second of 16 kHz audio; the emitter ignores it, the reader does not."""
    samples = np.zeros(16_000, dtype=np.float32)
    return write_wav(tmp_path / "span.wav", Pcm(samples=samples, sample_rate=16_000))


def _aligner(sequence: str, vocab_size: int = 6) -> IndicWav2VecAligner:
    """An aligner whose emitter always produces ``sequence`` of token ids."""
    frames = [int(character) for character in sequence]

    def emitter(samples: NDArray[np.float32], language: str) -> NDArray[np.float32]:
        del samples, language
        return emissions(frames, vocab_size=vocab_size)

    return IndicWav2VecAligner(emitter=emitter)


async def test_the_aligner_turns_frames_into_file_time(clip: Path) -> None:
    # Vocabulary is built from the prepared characters; "ab" -> {a: 1, b: 2}.
    aligner = _aligner("011022", vocab_size=3)
    words = await aligner.align(
        AlignmentRequest(audio_uri=str(clip), words=("a", "b"), language="ta", start_ms=2_000)
    )
    assert [word.t for word in words] == ["a", "b"]
    # 20 ms per frame, offset by the span start.
    assert words[0].s == 2_000 + 1 * 20
    assert words[0].e <= words[1].s
    assert words[1].e <= 3_000


async def test_an_injected_emitter_makes_the_aligner_available() -> None:
    assert _aligner("01").available() is None
    assert _aligner("01").available_for("hi") is None


async def test_words_outside_speech_snap_to_the_nearest_region(clip: Path) -> None:
    """`09 §2`: a word must never be highlighted over silence."""
    aligner = _aligner("011", vocab_size=2)
    regions = (SpeechRegion(start_ms=5_000, end_ms=6_000),)
    words = await aligner.align(
        AlignmentRequest(audio_uri=str(clip), words=("a",), language="hi", end_ms=1_000),
        regions,
    )
    assert 5_000 <= words[0].s <= 6_000


async def test_no_words_means_no_alignment(clip: Path) -> None:
    assert await _aligner("0").align(
        AlignmentRequest(audio_uri=str(clip), words=(), language="hi")
    ) == ()


async def test_an_aligner_with_no_audio_says_so() -> None:
    with pytest.raises(ValueError, match="needs audio"):
        await _aligner("011").align(
            AlignmentRequest(audio_uri="", words=("a",), language="hi", end_ms=100)
        )


def test_an_unconfigured_aligner_names_the_missing_directory(tmp_path: Path) -> None:
    assert "WORKER_AI_ALIGN_MODEL_DIR" in str(IndicWav2VecAligner().available())
    aligner = IndicWav2VecAligner(str(tmp_path))
    assert "no indicwav2vec checkpoints" in str(aligner.available())

    (tmp_path / "indicwav2vec").mkdir()
    aligner = IndicWav2VecAligner(str(tmp_path))
    assert aligner.available() is None
    # Present as a family, absent for this language.
    assert "no indicwav2vec checkpoint for ta" in str(aligner.available_for("ta"))


def test_the_indic_heads_cover_the_languages_the_brief_names() -> None:
    for language in ("hi", "bn", "gu", "mr", "ne", "or", "ta", "te", "kn", "ml"):
        assert IndicWav2VecAligner().covers(language), language
    assert IndicWav2VecAligner().covers("fr") is False


def test_mms_holds_one_checkpoint_for_every_language(tmp_path: Path) -> None:
    aligner = MmsAligner(str(tmp_path))
    assert aligner.language_dir("hi") == aligner.language_dir("ta")
    assert str(aligner.language_dir("hi")).endswith("multilingual")
    assert MmsAligner().language_dir("hi") is None


def test_the_licences_are_recorded_where_they_can_be_read() -> None:
    assert IndicWav2VecAligner.licence == "MIT"
    assert "CC-BY-NC" in MmsAligner.licence
    assert "unresolved" in MmsAligner.licence


def test_the_base_class_prepares_text_as_a_pass_through(clip: Path) -> None:
    del clip
    assert CtcAligner().prepare_text(("Toh", "AAJ"), "hi") == ("toh", "aaj")


# ---------------------------------------------------------------------------
# Script projection (`09 §2`)
# ---------------------------------------------------------------------------


def test_roman_hinglish_projects_onto_devanagari() -> None:
    """The Indic CTC vocabularies are Devanagari; Roman characters miss entirely."""
    projected = to_devanagari("matlab", "hi-en")
    assert projected != "matlab"
    assert all("ऀ" <= character <= "ॿ" for character in projected)


def test_devanagari_text_is_left_alone() -> None:
    assert to_devanagari("मतलब", "hi") == "मतलब"


def test_a_language_with_no_table_is_not_projected() -> None:
    """Projecting Tamil onto Devanagari would be worse than not aligning at all."""
    assert to_devanagari("vanakkam", "ta") == "vanakkam"


def test_romanisation_is_the_reverse_for_mms() -> None:
    assert romanise("मतलब").isascii()
    assert romanise("Video") == "video"
    assert romanise("") == ""


def test_the_projection_keeps_word_boundaries() -> None:
    words = ("toh", "aaj", "hum")
    projected = IndicWav2VecAligner().prepare_text(words, "hi-en")
    assert len(projected) == len(words)
    assert all(part for part in projected)
