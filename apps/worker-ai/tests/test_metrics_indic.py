"""D08's Indic-aware normalisation and the new quality metrics."""

from __future__ import annotations

from worker_ai.evals.metrics import (
    DiarisationSegment,
    autocut_precision_recall,
    diarisation_der,
    llm_pass_rate,
    normalise,
    transliteration_accuracy,
    wer,
    word_boundary_error,
)

#: U+200C ZWNJ, U+200D ZWJ -- built from codepoints, not typed literally, so
#: the test cannot silently degrade into comparing two identical strings.
_ZWNJ = chr(0x200C)
_ZWJ = chr(0x200D)


def test_zwnj_and_zwj_are_stripped_before_comparison() -> None:
    base = "क" + "्" + "ष" + "मित्र"  # a conjunct, plain
    with_zwnj = "क" + "्" + _ZWNJ + "ष" + "मित्र"
    with_zwj = "क" + "्" + _ZWJ + "ष" + "मित्र"
    assert normalise(with_zwnj) == normalise(base)
    assert normalise(with_zwj) == normalise(base)


def test_nukta_precomposed_and_decomposed_forms_are_equivalent() -> None:
    # JA WITH NUKTA (U+095B) vs ja (U+091C) + combining nukta (U+093C), and the
    # same for DDA/DDHA/FA -- the four with no Unicode canonical decomposition.
    pairs = [
        (0x095B, 0x091C),
        (0x095C, 0x0921),
        (0x095D, 0x0922),
        (0x095E, 0x092B),
    ]
    for precomposed_cp, base_cp in pairs:
        precomposed = chr(precomposed_cp)
        decomposed = chr(base_cp) + chr(0x093C)
        assert normalise(precomposed) == normalise(decomposed), hex(precomposed_cp)


def test_danda_is_still_punctuation() -> None:
    assert normalise("यह वाक्य है।") == normalise("यह वाक्य है")


def test_a_nukta_difference_no_longer_inflates_wer() -> None:
    # "film" in Devanagari with FA WITH NUKTA (precomposed) vs the same word
    # spelled with base fa + combining nukta -- a font/provider spelling choice,
    # not a different word.
    reference = "फ़िल्म"
    hypothesis = "फ़िल्म"
    assert wer(reference, hypothesis) == 0.0


def test_word_boundary_error_counts_disagreeing_spans() -> None:
    reference = [(0, 100), (100, 250), (250, 400)]
    hypothesis = [(0, 100), (100, 300), (250, 400)]
    assert word_boundary_error(reference, hypothesis) == 1 / 3


def test_word_boundary_error_is_none_on_length_mismatch() -> None:
    assert word_boundary_error([(0, 1)], [(0, 1), (1, 2)]) is None


def test_word_boundary_error_perfect_agreement_is_zero() -> None:
    spans = [(0, 100), (100, 200)]
    assert word_boundary_error(spans, spans) == 0.0


def test_diarisation_der_is_zero_for_a_perfect_match() -> None:
    segments = [DiarisationSegment("spk_a", 0, 1000), DiarisationSegment("spk_b", 1000, 2000)]
    assert diarisation_der(segments, segments) == 0.0


def test_diarisation_der_charges_speaker_confusion() -> None:
    reference = [DiarisationSegment("spk_a", 0, 1000)]
    hypothesis = [DiarisationSegment("spk_b", 0, 1000)]
    assert diarisation_der(reference, hypothesis) == 1.0


def test_diarisation_der_charges_only_the_uncovered_time() -> None:
    reference = [DiarisationSegment("spk_a", 0, 1000)]
    hypothesis = [DiarisationSegment("spk_a", 0, 500)]
    assert diarisation_der(reference, hypothesis) == 0.5


def test_diarisation_der_on_no_reference_time_is_zero() -> None:
    assert diarisation_der([], []) == 0.0


def test_transliteration_accuracy_is_exact_match_after_normalisation() -> None:
    assert transliteration_accuracy("नमस्ते", "नमस्ते") == 1.0
    assert transliteration_accuracy("नमस्ते", "namaste") == 0.0


def test_autocut_precision_recall_exact_match() -> None:
    cuts = [(0, 100), (200, 300)]
    result = autocut_precision_recall(cuts, cuts)
    assert result.precision == 1.0
    assert result.recall == 1.0
    assert result.f1 == 1.0
    assert result.true_positives == 2
    assert result.false_positives == 0
    assert result.false_negatives == 0


def test_autocut_precision_recall_within_tolerance_still_matches() -> None:
    reference = [(1000, 2000)]
    hypothesis = [(1050, 1950)]
    result = autocut_precision_recall(reference, hypothesis, tolerance_ms=150)
    assert result.true_positives == 1
    assert result.precision == 1.0
    assert result.recall == 1.0


def test_autocut_precision_recall_beyond_tolerance_is_a_miss() -> None:
    reference = [(1000, 2000)]
    hypothesis = [(1500, 2500)]
    result = autocut_precision_recall(reference, hypothesis, tolerance_ms=150)
    assert result.true_positives == 0
    assert result.false_positives == 1
    assert result.false_negatives == 1


def test_autocut_precision_recall_does_not_double_count_a_duplicate_proposal() -> None:
    reference = [(0, 100)]
    hypothesis = [(0, 100), (0, 100)]
    result = autocut_precision_recall(reference, hypothesis)
    assert result.true_positives == 1
    assert result.false_positives == 1


def test_autocut_precision_recall_on_empty_hypothesis_is_zero_recall() -> None:
    result = autocut_precision_recall([(0, 100)], [])
    assert result.recall == 0.0
    assert result.precision == 1.0  # vacuous: nothing proposed, nothing wrong


def test_llm_pass_rate() -> None:
    assert llm_pass_rate([]) == 1.0
    assert llm_pass_rate([True, True, True, True]) == 1.0
    assert llm_pass_rate([True, False]) == 0.5
    assert llm_pass_rate([False, False]) == 0.0
