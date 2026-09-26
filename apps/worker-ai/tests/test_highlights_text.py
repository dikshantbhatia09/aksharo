"""Sentence ends, titles and excerpts for highlight discovery, in both scripts."""

from __future__ import annotations

import unicodedata

import pytest

from worker_ai.highlights.text import (
    EXCERPT_MAX_CHARS,
    TITLE_MAX_CHARS,
    clean_word,
    ends_clause,
    ends_sentence,
    ends_sentence_before,
    is_question,
    is_speech,
    make_excerpt,
    make_title,
    normalise,
)


def words(text: str) -> list[str]:
    return text.split()


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("hain।", True),  # danda: Sarvam's romanized Hinglish
        ("है।", True),
        ("dosto॥", True),  # double danda
        ("done.", True),
        ("really?!", True),
        ("wait...", True),
        ("so…", True),
        ('"no."', True),  # the mark inside closing quotes
        ("(yes!)", True),
        ("No.", True),  # the spoken reply, far more common than "number"
        ("Mr.", False),
        ("U.S.", False),
        ("e.g.", False),
        ("again,", False),
        ("नमस्ते", False),
        ("3.5", False),
    ],
)
def test_sentence_ends_in_latin_and_devanagari(word: str, expected: bool) -> None:
    assert ends_sentence(word) is expected


@pytest.mark.parametrize(
    ("word", "following", "expected"),
    [
        ("No.", "that", True),
        ("No.", None, True),
        ("No.", "5", False),  # "No. 5": number five
        ("no.", "५", False),  # a Devanagari digit five
        ("done.", "5", True),
        ("Mr.", "Singh", False),
    ],
)
def test_no_ends_a_sentence_unless_a_number_follows(
    word: str, following: str | None, expected: bool
) -> None:
    assert ends_sentence_before(word, following) is expected


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("hello", True),
        ("नमस्ते", True),
        ("2019", True),
        ("५", True),  # a Devanagari digit
        ("♪", False),  # the note Whisper writes over music
        ("\U0001f3b5", False),
        ("♪♪", False),
        ("[Music]", False),  # a sound label, not something said
        ("[संगीत]", False),
        ("...", False),
        ("।", False),
        ("(yes!)", True),
    ],
)
def test_is_speech(word: str, expected: bool) -> None:
    assert is_speech(word) is expected


def test_clause_marks_and_questions() -> None:
    assert ends_clause("again,")
    assert ends_clause("first;")
    assert not ends_clause("again")
    assert is_question("kyun?")
    assert is_question("really?!")
    assert not is_question("done.")


def test_normalise_compares_words_whatever_their_encoding() -> None:
    precomposed = "\u095b\u0930\u0942\u0930"  # za as one code point, U+095B
    decomposed = "\u091c\u093c\u0930\u0942\u0930"  # ja followed by a nukta
    assert normalise(precomposed) == normalise(decomposed)
    assert normalise("\u201cHere\u2019s,\u201d") == "here's"
    assert normalise("है।") == "है"


def test_clean_word_keeps_marks_and_joiners_and_drops_the_invisible() -> None:
    assert clean_word("करेंगे") == "करेंगे"
    assert clean_word("नमस्ते") == "नमस्ते"
    # A zero-width joiner chooses a half form in Devanagari; it is part of the word.
    assert clean_word("\u0915\u094d\u200d\u0937") == "\u0915\u094d\u200d\u0937"
    assert clean_word("we're") == "we're"
    assert clean_word("fire\U0001f525") == "fire"
    assert clean_word("bad\x07bell") == "badbell"
    assert clean_word("₹500") == "₹500"


def test_a_devanagari_title_is_the_speakers_words_intact() -> None:
    """The first version returned 'नमसत दसत आज हम बत करग' for this."""
    title = make_title(words("नमस्ते दोस्तों आज हम बात करेंगे।"), fallback="x")

    assert title == unicodedata.normalize("NFC", "नमस्ते दोस्तों आज हम बात करेंगे")


def test_an_english_title_keeps_apostrophes_and_acronyms() -> None:
    """`.title()` made 'we're' into 'Were' and 'AI' into 'Ai'."""
    title = make_title(words("it's what we're doing with AI today."), fallback="x")

    assert title == "It's what we're doing with AI today"


def test_a_title_skips_fillers_and_dangling_connectives() -> None:
    title = make_title(words("um so the secret is patience."), fallback="x")

    assert title == "The secret is patience"


def test_a_title_keeps_a_question_mark() -> None:
    assert make_title(words("why does nobody check this?"), fallback="x") == (
        "Why does nobody check this?"
    )


def test_a_short_first_sentence_reads_on_into_the_next() -> None:
    title = make_title(words("Yes. That is the whole point of it."), fallback="x")

    assert title == "Yes. That is the whole point of it"


def test_a_title_reads_on_past_no_before_a_number() -> None:
    """ "No." ends a sentence now, except where it means "number"."""
    assert make_title(words("We ranked it No. 5 on the list."), fallback="x") == (
        "We ranked it No. 5 on the list"
    )
    assert make_title(words("I asked him and he said No. Then we left."), fallback="x") == (
        "I asked him and he said No"
    )


def test_a_long_title_is_cut_at_a_word_boundary() -> None:
    tokens = words(
        "This sentence keeps going far past the point where any title should stop "
        "because nobody reads that much on a card."
    )

    title = make_title(tokens, fallback="x")

    assert len(title) <= TITLE_MAX_CHARS
    assert title.endswith("…")
    body = title.removesuffix("…")
    assert " ".join(tokens).startswith(body)
    # The cut is between words, never inside one.
    assert body.split()[-1] in tokens


def test_a_single_overlong_devanagari_word_is_not_cut_inside_a_letter() -> None:
    word = "क्षत्रिय" * 20

    title = make_title([word], fallback="x")

    body = title.removesuffix("…")
    assert len(title) <= TITLE_MAX_CHARS
    assert unicodedata.category(word[len(body)])[0] != "M"


def test_a_title_with_nothing_readable_uses_the_fallback() -> None:
    assert make_title(["\U0001f525", "\U0001f525"], fallback="Moment at 1:05") == "Moment at 1:05"


def test_an_excerpt_fits_the_contract() -> None:
    words = ["word"] * 1_000

    excerpt = make_excerpt(words)

    assert len(excerpt) <= EXCERPT_MAX_CHARS + 1
    assert excerpt.endswith("…")
    assert make_excerpt(["a", "b."]) == "a b."
