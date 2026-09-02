from __future__ import annotations

from worker_ai.hints import MAX_HINT_LENGTH, prepare_hints


def test_dedupes_case_insensitively_and_preserves_first_casing() -> None:
    assert prepare_hints(["Aksharo", "aksharo", "AKSHARO"]) == ("Aksharo",)


def test_trims_whitespace() -> None:
    assert prepare_hints(["  Aksharo  ", "Sarvam"]) == ("Aksharo", "Sarvam")


def test_drops_empty_and_over_long_terms() -> None:
    long_term = "x" * (MAX_HINT_LENGTH + 1)
    assert prepare_hints(["", "   ", "Aksharo", long_term]) == ("Aksharo",)


def test_caps_the_count_keeping_input_order() -> None:
    terms = [f"term{i}" for i in range(10)]
    assert prepare_hints(terms, cap=3) == ("term0", "term1", "term2")


def test_empty_input_yields_empty_tuple() -> None:
    assert prepare_hints([]) == ()
