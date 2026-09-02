"""Two-signal language identification (D14, `09 §1.1`)."""

from __future__ import annotations

from typing import Any

import pytest

from worker_ai.lid import (
    CODE_MIX_THRESHOLD,
    LID_LONG_WINDOW_MS,
    GpuLanguageIdentifier,
    IndicLidClassifier,
    LanguageSignal,
    ProviderLanguageIdentifier,
    WhisperLanguageIdentifier,
    decide_language,
    lid_windows,
    romanised_hindi_share,
    script_profile,
)
from worker_ai.vad import SpeechRegion

HINGLISH = "toh aaj hum baat karenge video editing ke baare mein"
ENGLISH = "so today we are going to talk about video editing and captions"
HINDI = "तो आज हम बात करेंगे वीडियो एडिटिंग के बारे में"


def signal(source: str, language: str, confidence: float = 0.9, **extra: Any) -> LanguageSignal:
    return LanguageSignal(source=source, language=language, confidence=confidence, **extra)


# ---------------------------------------------------------------------------
# The windows (D14)
# ---------------------------------------------------------------------------


def test_the_scan_is_sixty_seconds_plus_two_fifteen_second_windows() -> None:
    windows = lid_windows(10 * 60 * 1000)
    assert len(windows) == 3
    assert windows[0] == (0, LID_LONG_WINDOW_MS)
    assert [end - start for start, end in windows[1:]] == [15_000, 15_000]


def test_the_long_window_starts_at_the_first_speech_not_at_zero() -> None:
    """Eight seconds of room tone should not eat the LID budget."""
    regions = (SpeechRegion(start_ms=8_000, end_ms=200_000),)
    windows = lid_windows(10 * 60 * 1000, regions)
    assert windows[0] == (8_000, 68_000)


def test_a_short_clip_gets_one_window() -> None:
    assert lid_windows(4_000) == ((0, 4_000),)


def test_no_audio_means_no_windows() -> None:
    assert lid_windows(0) == ()


# ---------------------------------------------------------------------------
# The text classifier
# ---------------------------------------------------------------------------


def test_script_profile_separates_devanagari_from_latin() -> None:
    assert script_profile(HINDI)["devanagari"] > 0.9
    assert script_profile(ENGLISH)["latin"] == 1.0
    assert script_profile("")["latin"] == 0.0


def test_the_code_mix_score_is_the_romanised_hindi_share() -> None:
    assert romanised_hindi_share(HINGLISH) >= CODE_MIX_THRESHOLD
    assert romanised_hindi_share(ENGLISH) < CODE_MIX_THRESHOLD
    # Devanagari is Hindi, not code-mix.
    assert romanised_hindi_share(HINDI) == 0.0
    assert romanised_hindi_share("") == 0.0


def test_words_spelled_the_same_in_both_languages_are_not_counted() -> None:
    """"the main par" is English; scoring it as Hinglish would route it wrongly."""
    assert romanised_hindi_share("the main par") == 0.0


def test_the_classifier_calls_hinglish_hinglish() -> None:
    result = IndicLidClassifier().classify(HINGLISH)
    assert result.language == "hi-en"
    assert result.code_mix_score is not None
    assert result.code_mix_score >= CODE_MIX_THRESHOLD
    assert result.detail["backend"] == "heuristic"


def test_the_classifier_calls_english_english_and_devanagari_hindi() -> None:
    assert IndicLidClassifier().classify(ENGLISH).language == "en"
    assert IndicLidClassifier().classify(HINDI).language == "hi"


def test_the_classifier_has_no_opinion_about_nothing() -> None:
    assert IndicLidClassifier().classify("   ").language == ""


def test_a_missing_model_directory_falls_back_rather_than_failing(tmp_path: Any) -> None:
    classifier = IndicLidClassifier(str(tmp_path / "absent"))
    assert classifier.backend == "heuristic"
    assert classifier.classify(HINGLISH).language == "hi-en"


def test_an_injected_model_is_used_when_one_exists() -> None:
    class _FakeFastText:
        def predict(self, text: str, k: int = 1) -> tuple[list[str], list[float]]:
            del text, k
            return ["__label__hin_Deva"], [0.99]

    classifier = IndicLidClassifier(model=_FakeFastText())
    result = classifier.classify(HINDI)
    assert classifier.backend == "indiclid"
    assert result.language == "hi"
    assert result.confidence == 0.99


# ---------------------------------------------------------------------------
# The acoustic identifiers
# ---------------------------------------------------------------------------


async def test_the_provider_identifier_echoes_what_the_adapter_reported() -> None:
    result = await ProviderLanguageIdentifier("hin", 0.9, provider="elevenlabs").identify("a", ())
    assert result.language == "hi"
    assert result.confidence == 0.9
    assert result.detail["provider"] == "elevenlabs"


async def test_whisper_pools_its_windows_by_probability() -> None:
    calls: list[tuple[int, int]] = []

    class _FakeWhisper:
        def detect_language(self, audio: str, clip_timestamps: list[float]) -> tuple[str, float]:
            del audio
            calls.append((int(clip_timestamps[0] * 1000), int(clip_timestamps[1] * 1000)))
            # Two windows say Hindi weakly, one says English strongly.
            return ("en", 0.8) if len(calls) == 2 else ("hi", 0.6)

    identifier = WhisperLanguageIdentifier(model_factory=_FakeWhisper)
    windows = ((0, 60_000), (100_000, 115_000), (200_000, 215_000))
    result = await identifier.identify("a.wav", windows)

    assert len(calls) == 3
    # 0.6 + 0.6 for Hindi beats 0.8 for English.
    assert result.language == "hi"
    assert 0 < result.confidence < 1


async def test_whisper_with_no_readable_window_has_no_opinion() -> None:
    class _Silent:
        def detect_language(self, audio: str, clip_timestamps: list[float]) -> tuple[str, float]:
            del audio, clip_timestamps
            return ("", 0.0)

    result = await WhisperLanguageIdentifier(model_factory=_Silent).identify("a.wav", ((0, 1),))
    assert result.present is False


def test_the_gpu_identifier_needs_an_endpoint() -> None:
    assert "GPU_PROVIDER_URL" in str(GpuLanguageIdentifier("").available())
    assert GpuLanguageIdentifier("https://gpu.test").available() is None


async def test_the_gpu_identifier_reads_the_model_server_shape() -> None:
    from worker_ai.evals.replay import build_replay_provider, load_session, replay_transport
    from worker_ai.providers.http import VendorHttp

    del build_replay_provider
    import httpx2

    session = load_session("gpu-whisper")
    identifier = GpuLanguageIdentifier(
        session.base_url,
        http=VendorHttp(
            provider="serverless-whisper",
            base_url=session.base_url,
            client=httpx2.AsyncClient(transport=replay_transport(session)),
        ),
    )
    result = await identifier.identify("a.wav", ((0, 60_000),))
    assert (result.language, result.confidence) == ("hi", 0.88)


# ---------------------------------------------------------------------------
# The rule (D14)
# ---------------------------------------------------------------------------


def test_both_signals_agreeing_on_hinglish_with_a_high_score_is_the_code_mix_lane() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "hi"),
        textual=LanguageSignal(source="indiclid", language="hi-en", code_mix_score=0.7),
    )
    assert decision.code_mix is True
    assert decision.language == "hi-en"
    assert decision.low_confidence is False
    assert "0.7" in decision.reason


def test_agreement_on_hindi_without_the_score_is_not_the_code_mix_lane() -> None:
    """`09 §1.2`: the romanised share has to clear 0.3, or it is plain Hindi."""
    decision = decide_language(
        acoustic=signal("whisper", "hi"),
        textual=LanguageSignal(source="indiclid", language="hi", code_mix_score=0.05),
    )
    assert decision.code_mix is False
    assert decision.language == "hi"


def test_one_signal_claiming_code_mix_alone_is_not_enough() -> None:
    """RR-02 F4: romanised IndicLID at F1 0.75 cannot carry this decision alone."""
    decision = decide_language(
        acoustic=signal("whisper", "en"),
        textual=LanguageSignal(source="indiclid", language="hi-en", code_mix_score=0.9),
    )
    assert decision.code_mix is False
    assert decision.low_confidence is True
    assert "needs both" in decision.reason


def test_a_hinglish_hint_wins_outright() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "en", 0.99),
        textual=LanguageSignal(source="indiclid", language="en", code_mix_score=0.0),
        hint="hinglish",
    )
    assert decision.code_mix is True
    assert decision.language == "hi-en"
    assert decision.from_hint is True
    assert decision.low_confidence is False


def test_a_pinned_language_hint_wins_too() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "en"),
        textual=signal("indiclid", "en"),
        hint="ta",
    )
    assert (decision.language, decision.from_hint) == ("ta", True)


def test_agreement_ignores_the_region_subtag() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "hi"), textual=signal("indiclid", "hi-IN")
    )
    assert decision.language == "hi"
    assert decision.low_confidence is False


def test_disagreement_takes_the_acoustic_signal_and_flags_it() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "ta", 0.8), textual=signal("indiclid", "ml", 0.6)
    )
    assert decision.language == "ta"
    assert decision.low_confidence is True
    assert "disagree" in decision.reason


def test_one_signal_alone_is_used_and_flagged() -> None:
    decision = decide_language(
        acoustic=signal("whisper", "bn"), textual=LanguageSignal(source="indiclid", language="")
    )
    assert decision.language == "bn"
    assert decision.low_confidence is True


def test_no_signal_at_all_is_an_empty_answer_not_a_guess() -> None:
    decision = decide_language(
        acoustic=LanguageSignal(source="whisper", language=""),
        textual=LanguageSignal(source="indiclid", language=""),
    )
    assert decision.language == ""
    assert decision.low_confidence is True


def test_the_decision_serialises_for_the_job_log() -> None:
    """`09 §1`: the routing decision is logged per job, reasons included."""
    decision = decide_language(
        acoustic=signal("whisper", "hi", 0.95),
        textual=LanguageSignal(source="indiclid", language="hi-en", code_mix_score=0.62),
    )
    wire = decision.to_wire()
    assert wire["language"] == "hi-en"
    assert wire["codeMix"] is True
    assert wire["codeMixScore"] == 0.62
    assert [item["source"] for item in wire["signals"]] == ["whisper", "indiclid"]
    assert wire["reason"]


@pytest.mark.parametrize(
    ("acoustic_language", "text", "expected_lane_language", "code_mix"),
    [
        ("hi", HINGLISH, "hi-en", True),
        ("hi", HINDI, "hi", False),
        ("en", ENGLISH, "en", False),
    ],
)
def test_end_to_end_signal_pairs(
    acoustic_language: str, text: str, expected_lane_language: str, code_mix: bool
) -> None:
    decision = decide_language(
        acoustic=signal("whisper", acoustic_language),
        textual=IndicLidClassifier().classify(text),
    )
    assert (decision.language, decision.code_mix) == (expected_lane_language, code_mix)
