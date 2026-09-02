"""The CTC forced-alignment maths, against hand-written emission matrices.

The point of testing this against matrices rather than a 1.2 GB checkpoint is
that the two classic bugs — arithmetic in probability space instead of log space,
and a missing blank between two identical characters — are both visible in a
six-frame matrix and both invisible in an end-to-end test that only checks the
timings look plausible.
"""

from __future__ import annotations

import numpy as np
import pytest

from model_server.models.aligner import (
    FAMILIES,
    INDIC_LANGUAGES,
    family_for,
    forced_align,
    log_softmax,
    word_frames,
)


def emissions(frames: list[int], vocab_size: int = 4, confidence: float = 20.0) -> np.ndarray:
    """A log-prob matrix that all but forces one token per frame."""
    logits = np.zeros((len(frames), vocab_size), dtype=np.float32)
    for index, token in enumerate(frames):
        logits[index, token] = confidence
    return log_softmax(logits)


def test_each_token_lands_on_the_frame_that_emitted_it() -> None:
    # blank=0, tokens 1, 2, 3 emitted on frames 1, 3 and 5.
    log_probs = emissions([0, 1, 0, 2, 0, 3])
    spans = forced_align(log_probs, [1, 2, 3], blank=0)
    assert spans == [(1, 2), (3, 4), (5, 6)]


def test_a_repeated_character_keeps_its_separating_blank() -> None:
    """ "ll" must not collapse to one "l"; the blank between the copies is required."""
    log_probs = emissions([1, 0, 1])
    spans = forced_align(log_probs, [1, 1], blank=0)
    assert spans[0][0] == 0
    assert spans[1][0] >= spans[0][1], "the second copy must start after the first ends"
    assert spans[1][1] == 3


def test_the_recursion_survives_a_long_utterance_without_underflow() -> None:
    """A thousand frames of multiplication underflows float32; adding logs does not."""
    pattern = [0, 1, 0, 2] * 250
    log_probs = emissions(pattern)
    spans = forced_align(log_probs, [1, 2] * 250, blank=0)
    assert len(spans) == 500
    assert all(np.isfinite(start) and np.isfinite(end) for start, end in spans)
    assert spans[-1][1] <= len(pattern)


def test_more_tokens_than_frames_is_an_error_the_caller_must_handle() -> None:
    log_probs = emissions([1, 2])
    with pytest.raises(ValueError, match="cannot align"):
        forced_align(log_probs, [1, 2, 3], blank=0)


def test_no_tokens_is_no_spans() -> None:
    assert forced_align(emissions([0]), [], blank=0) == []


def test_word_frames_groups_tokens_back_into_words() -> None:
    spans = [(0, 2), (2, 4), (5, 7), (7, 9)]
    assert word_frames(spans, (2, 2)) == [(0, 4), (5, 9)]


def test_word_frames_gives_a_zero_width_span_to_a_word_with_no_tokens() -> None:
    spans = [(0, 3)]
    assert word_frames(spans, (1, 0)) == [(0, 3), (3, 3)]


def test_log_softmax_normalises_each_frame() -> None:
    values = log_softmax(np.array([[1.0, 2.0, 3.0]], dtype=np.float32))
    assert abs(float(np.exp(values).sum()) - 1.0) < 1e-5


# ---------------------------------------------------------------------------
# Decision D77: which family serves which language
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("language", sorted(INDIC_LANGUAGES))
def test_indic_languages_route_to_the_mit_indicwav2vec_heads(language: str) -> None:
    assert family_for(language) == "indicwav2vec"
    assert FAMILIES["indicwav2vec"] == ("ai4bharat/indicwav2vec", "MIT")


@pytest.mark.parametrize("language", ["en", "de", "fr", "ja", "sw", "pt-BR", "EN-GB"])
def test_global_languages_route_to_the_apache_xlsr53_fine_tunes(language: str) -> None:
    assert family_for(language) == "xlsr53"
    assert FAMILIES["xlsr53"][1] == "Apache-2.0"


def test_the_licence_table_holds_only_commercially_usable_models() -> None:
    """D77: nothing CC-BY-NC may be reachable from this server."""
    for model, licence in FAMILIES.values():
        assert "NC" not in licence
        assert "mms" not in model.casefold()
