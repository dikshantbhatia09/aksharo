"""Golden transliteration tests (`09 §4`, A22): Hinglish and Tamil, both directions,
English-word preservation, and the `ai.transliterate` processor end to end."""

from __future__ import annotations

import httpx2
import pytest

from worker_ai.processors import process_transliterate
from worker_ai.processors.context import JobFailureError
from worker_ai.providers.base import ProviderError
from worker_ai.transliterate import (
    IndicXlitHttpProvider,
    RuleTableTransliterationProvider,
    TransliterationRequest,
    transliterate_words,
)
from worker_ai.transliterate.english import is_english_token

from .test_processors import build_services, context_for, recorder

# ---------------------------------------------------------------------------
# English-word preservation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("video", True),
        ("Channel", True),
        ("interesting", True),
        ("subscribe", True),
        ("recording", True),  # morphology: -ing, len >= 5
        ("ho", False),  # too short for morphology, not in the dictionary
        ("kaise", False),
        ("namaste", False),
        ("यह", False),  # not Latin at all
        ("123", False),
    ],
)
def test_english_token_detection(token: str, expected: bool) -> None:
    assert is_english_token(token) is expected


# ---------------------------------------------------------------------------
# Golden sentence: Hinglish -> Devanagari (native), preserving English words
# ---------------------------------------------------------------------------

HINGLISH_SENTENCE = "toh aaj hum baat karenge aapke channel ke baare mein"
# "channel" is a common code-switched English loanword (also in ENGLISH_WORDS),
# so the Hinglish preservation rule wins over the Hindi dictionary entry for it
# — the whole point of `09 §4`'s "English words preserved".
HINGLISH_NATIVE_EXPECTED = "तो आज हम बात करेंगे आपके channel के बारे में"

HINGLISH_WITH_ENGLISH = ["yeh", "video", "bahut", "interesting", "hai"]
HINGLISH_WITH_ENGLISH_NATIVE = ["यह", "video", "बहुत", "interesting", "है"]


async def test_hinglish_sentence_transliterates_to_devanagari() -> None:
    words = tuple((str(index), token) for index, token in enumerate(HINGLISH_SENTENCE.split()))
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(provider, words=words, language="hi", target="native")

    native = " ".join(word.text for word in result.words)
    assert native == HINGLISH_NATIVE_EXPECTED


async def test_hinglish_english_words_are_preserved_in_native_output() -> None:
    words = tuple((str(index), token) for index, token in enumerate(HINGLISH_WITH_ENGLISH))
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(provider, words=words, language="hi", target="native")

    native = [word.text for word in result.words]
    assert native == HINGLISH_WITH_ENGLISH_NATIVE
    # "video" and "interesting" were left exactly as typed.
    assert [word.preserved for word in result.words] == [False, True, False, True, False]
    assert result.unchanged == 2


async def test_devanagari_romanises_back_via_the_dictionary() -> None:
    words = (("0", "तो"), ("1", "आज"), ("2", "हम"))
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(provider, words=words, language="hi", target="roman")

    assert [word.text for word in result.words] == ["toh", "aaj", "hum"]


# ---------------------------------------------------------------------------
# Golden sentence: Tamil
# ---------------------------------------------------------------------------

TAMIL_SENTENCE = "vanakkam nanba eppadi irukkinga"
TAMIL_NATIVE_EXPECTED = "வணக்கம் நண்பா எப்படி இருக்கிங்க"


async def test_tamil_sentence_transliterates_to_tamil_script() -> None:
    words = tuple((str(index), token) for index, token in enumerate(TAMIL_SENTENCE.split()))
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(provider, words=words, language="ta", target="native")

    native = " ".join(word.text for word in result.words)
    assert native == TAMIL_NATIVE_EXPECTED


# ---------------------------------------------------------------------------
# Numerals and punctuation
# ---------------------------------------------------------------------------


async def test_numerals_become_the_target_scripts_digits() -> None:
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(
        provider, words=(("0", "2026"),), language="hi", target="native"
    )
    assert result.words[0].text == "२०२६"


async def test_a_sentence_final_stop_becomes_the_devanagari_danda() -> None:
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(
        provider, words=(("0", "."),), language="hi", target="native"
    )
    assert result.words[0].text == "।"


async def test_an_unsupported_language_passes_words_through_unchanged() -> None:
    provider = RuleTableTransliterationProvider()
    result = await transliterate_words(
        provider, words=(("0", "bonjour"),), language="fr", target="native"
    )
    assert result.words[0].text == "bonjour"


# ---------------------------------------------------------------------------
# Out-of-dictionary fallback (syllable split)
# ---------------------------------------------------------------------------


async def test_an_out_of_dictionary_hindi_word_is_syllable_split() -> None:
    provider = RuleTableTransliterationProvider()
    # "kaha" (said) is not in the golden dictionary; ka + ha -> कह.
    result = await transliterate_words(
        provider, words=(("0", "kaha"),), language="hi", target="native"
    )
    assert result.words[0].text == "कह"


async def test_an_unmapped_syllable_falls_back_to_the_original_token() -> None:
    provider = RuleTableTransliterationProvider()
    # No consonant or vowel in the table starts with "x", so the greedy split
    # cannot even begin — the untouched token comes back rather than a partial
    # or garbled transliteration.
    result = await transliterate_words(
        provider, words=(("0", "xyzqwe"),), language="hi", target="native"
    )
    assert result.words[0].text == "xyzqwe"


# ---------------------------------------------------------------------------
# The IndicXlit HTTP provider (fixture-driven; no live model server exists)
# ---------------------------------------------------------------------------


async def test_indicxlit_http_provider_calls_the_served_model() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"words": ["यह", "है"]})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = IndicXlitHttpProvider(base_url="https://indicxlit.invalid", client=client)
    requests = (
        TransliterationRequest(wid="0", text="yeh", language="hi", target="native"),
        TransliterationRequest(wid="1", text="hai", language="hi", target="native"),
    )
    result = await provider.transliterate(requests)
    await provider.aclose()

    assert [item.text for item in result] == ["यह", "है"]
    assert result[0].submissions[0].provider == "indicxlit"


async def test_indicxlit_http_provider_rejects_a_mismatched_response_length() -> None:
    async def handler(_request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"words": ["only-one"]})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = IndicXlitHttpProvider(base_url="https://indicxlit.invalid", client=client)
    requests = (
        TransliterationRequest(wid="0", text="yeh", language="hi", target="native"),
        TransliterationRequest(wid="1", text="hai", language="hi", target="native"),
    )
    with pytest.raises(ProviderError):
        await provider.transliterate(requests)
    await provider.aclose()


# ---------------------------------------------------------------------------
# The `ai.transliterate` processor end to end
# ---------------------------------------------------------------------------


async def test_process_transliterate_writes_scripts_and_completes() -> None:
    services = build_services()
    context = context_for(
        "ai.transliterate",
        services=services,
        transcriptId="01JBQ8Z2W4N7Y0K3M5P8R1T6VE",
        language="hi",
        targetScript="native",
        words=[
            {"wid": "0:0", "t": "toh"},
            {"wid": "0:1", "t": "aaj"},
            {"wid": "0:2", "t": "video"},
        ],
    )
    outcome = await process_transliterate(context)

    assert outcome.result["wordsUpdated"] == 3
    assert outcome.result["wordsPreserved"] == 1  # "video"
    calls = recorder(services).transcript_scripts_calls
    assert len(calls) == 1
    transcript_id, payload = calls[0]
    assert transcript_id == "01JBQ8Z2W4N7Y0K3M5P8R1T6VE"
    words = {entry["wid"]: entry["text"] for entry in payload["words"]}
    assert words == {"0:0": "तो", "0:1": "आज", "0:2": "video"}


async def test_process_transliterate_rejects_an_invalid_target_script() -> None:
    context = context_for(
        "ai.transliterate",
        transcriptId="t1",
        language="hi",
        targetScript="translated",
        words=[{"wid": "0:0", "t": "hi"}],
    )
    with pytest.raises(JobFailureError, match="roman or native"):
        await process_transliterate(context)


async def test_process_transliterate_rejects_an_empty_words_list() -> None:
    context = context_for(
        "ai.transliterate", transcriptId="t1", language="hi", targetScript="native", words=[]
    )
    with pytest.raises(JobFailureError, match="non-empty words"):
        await process_transliterate(context)
