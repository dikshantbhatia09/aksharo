"""The alignment registry (D13), the proportional aligner and diarisation."""

from __future__ import annotations

from itertools import pairwise

import pytest
from hypothesis import given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from worker_ai.alignment import (
    AlignerRegistry,
    AlignmentUnavailableError,
    ElevenLabsForcedAligner,
    IndicWav2VecAligner,
    ProportionalAligner,
    Xlsr53Aligner,
    distribute,
)
from worker_ai.diarisation import (
    DiarisationUnavailableError,
    DiariserRegistry,
    NoopDiariser,
    PyannoteCommunityDiariser,
)
from worker_ai.providers.base import AlignmentRequest, DiarisationRequest
from worker_ai.vad import SpeechRegion

REGISTRY = AlignerRegistry.default()

# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


def test_the_chain_is_the_order_from_the_pipeline_document() -> None:
    """IndicWav2Vec -> the model server -> ElevenLabs FA -> proportional (`09 §2`)."""
    assert [aligner.name for aligner in REGISTRY.chain("hi")] == [
        "indicwav2vec-ctc",
        "gpu-ctc",
        "elevenlabs-fa",
        "proportional-vad",
    ]


def test_a_global_language_gets_the_apache_licensed_rung_not_the_indic_heads() -> None:
    """D77: rung 3 is per-language XLSR-53, so the split is by language family."""
    assert [aligner.name for aligner in REGISTRY.chain("fr")] == [
        "xlsr53-ctc",
        "gpu-ctc",
        "elevenlabs-fa",
        "proportional-vad",
    ]


def test_a_language_neither_local_ctc_family_covers_still_has_three_rungs() -> None:
    """The model server picks a family per language, so it claims every one."""
    assert [aligner.name for aligner in REGISTRY.chain("sw")] == [
        "gpu-ctc",
        "elevenlabs-fa",
        "proportional-vad",
    ]


def test_the_proportional_fallback_is_what_resolves_without_models_or_keys() -> None:
    """No checkpoints, no ElevenLabs key: the bottom rung is the only one left."""
    for language in ("hi", "hi-en", "ta-IN", "fr", "und"):
        assert REGISTRY.resolve(language).name == "proportional-vad"


def test_an_empty_chain_is_an_error() -> None:
    with pytest.raises(AlignmentUnavailableError):
        AlignerRegistry(aligners=()).resolve("hi")


def test_a_chain_of_only_unavailable_aligners_reports_every_reason() -> None:
    registry = AlignerRegistry(aligners=(IndicWav2VecAligner(), ElevenLabsForcedAligner()))
    with pytest.raises(AlignmentUnavailableError, match=r"indicwav2vec-ctc.*elevenlabs-fa"):
        registry.resolve("hi")


def test_describe_reports_availability_for_the_control_app() -> None:
    rows = {row["name"]: row for row in REGISTRY.describe("hi")}
    assert rows["proportional-vad"]["available"] is True
    assert rows["indicwav2vec-ctc"]["available"] is False
    assert "WORKER_AI_ALIGN_MODEL_DIR" in str(rows["indicwav2vec-ctc"]["reason"])
    assert rows["indicwav2vec-ctc"]["licence"] == "MIT"


def test_the_model_backed_aligners_carry_their_model_and_licence() -> None:
    assert IndicWav2VecAligner.licence == "MIT"
    assert IndicWav2VecAligner.model.startswith("ai4bharat/")
    assert Xlsr53Aligner.model.startswith("jonatasgrosman/wav2vec2-large-xlsr-53")
    assert Xlsr53Aligner.licence == "Apache-2.0"
    assert ElevenLabsForcedAligner.cost_per_minute_inr == pytest.approx(0.03)


def test_an_unconfigured_model_backed_aligner_says_what_is_missing() -> None:
    """No credential and no checkpoint is a *reason*, never a stack trace."""
    assert "WORKER_AI_ALIGN_MODEL_DIR" in str(IndicWav2VecAligner().available())
    assert "WORKER_AI_ALIGN_MODEL_DIR" in str(Xlsr53Aligner().available())
    assert "ELEVENLABS_API_KEY" in str(ElevenLabsForcedAligner().available())


# ---------------------------------------------------------------------------
# ProportionalAligner
# ---------------------------------------------------------------------------


def test_longer_words_get_more_time() -> None:
    timings = distribute(("a", "bbbbbbbb"), 0, 900)
    assert timings[0][1] - timings[0][0] < timings[1][1] - timings[1][0]


def test_words_are_placed_on_speech_and_never_in_the_silence_between() -> None:
    regions = (
        SpeechRegion(start_ms=0, end_ms=1_000),
        SpeechRegion(start_ms=4_000, end_ms=5_000),
    )
    timings = distribute(("ek", "do", "teen", "chaar"), 0, 5_000, regions)

    for start, end in timings:
        assert any(
            region.start_ms <= start <= region.end_ms and region.start_ms <= end <= region.end_ms
            for region in regions
        ), (start, end)


def test_with_no_regions_the_span_itself_is_the_timeline() -> None:
    timings = distribute(("ek", "do"), 1_000, 3_000)
    assert timings[0][0] == 1_000
    assert timings[-1][1] == 3_000


def test_a_zero_length_span_collapses_rather_than_dividing_by_zero() -> None:
    assert distribute(("ek", "do"), 500, 500) == ((500, 500), (500, 500))


def test_no_words_means_no_timings() -> None:
    assert distribute((), 0, 1_000) == ()


async def test_the_aligner_applies_the_offset_and_keeps_the_text() -> None:
    result = await ProportionalAligner().align(
        AlignmentRequest(
            audio_uri="",
            words=("toh", "aaj", "hum"),
            language="hi-en",
            start_ms=0,
            end_ms=3_000,
            offset_ms=600_000,
        )
    )
    assert [word.t for word in result] == ["toh", "aaj", "hum"]
    assert result[0].s == 600_000
    assert result[-1].e == 603_000


async def test_an_aligner_request_without_an_end_collapses_to_a_point() -> None:
    result = await ProportionalAligner().align(
        AlignmentRequest(audio_uri="", words=("ek",), language="hi", start_ms=250)
    )
    assert (result[0].s, result[0].e) == (250, 250)


@hypothesis_settings(max_examples=200, deadline=None)
@given(
    words=st.lists(
        st.text(
            alphabet=st.characters(min_codepoint=97, max_codepoint=122),
            min_size=1,
            max_size=12,
        ),
        min_size=1,
        max_size=25,
    ),
    start=st.integers(min_value=0, max_value=500_000),
    length=st.integers(min_value=0, max_value=120_000),
    gaps=st.lists(st.integers(min_value=0, max_value=120_000), min_size=0, max_size=6),
)
def test_property_alignment_is_monotonic_and_inside_the_span(
    words: list[str], start: int, length: int, gaps: list[int]
) -> None:
    """The invariant segmentation, `timemap` and the editor all assume."""
    end = start + length
    edges = sorted({min(start + gap, end) for gap in gaps})
    regions = tuple(
        SpeechRegion(start_ms=left, end_ms=right) for left, right in pairwise(edges) if right > left
    )

    timings = distribute(tuple(words), start, end, regions)

    assert len(timings) == len(words)
    previous_end = start
    for word_start, word_end in timings:
        assert start <= word_start <= word_end <= end
        assert word_start >= previous_end
        previous_end = word_end


# ---------------------------------------------------------------------------
# Diarisation
# ---------------------------------------------------------------------------


async def test_the_noop_diariser_labels_every_region_with_one_speaker() -> None:
    turns = await NoopDiariser().diarise(
        DiarisationRequest(audio_uri="a.wav", regions=((0, 1_000), (2_000, 3_500)))
    )
    assert [turn.to_wire() for turn in turns] == [
        {"speakerId": "S1", "startMs": 0, "endMs": 1_000, "confidence": 1.0},
        {"speakerId": "S1", "startMs": 2_000, "endMs": 3_500, "confidence": 1.0},
    ]


async def test_the_noop_diariser_drops_empty_regions() -> None:
    turns = await NoopDiariser().diarise(
        DiarisationRequest(audio_uri="a.wav", regions=((0, 0), (1_000, 2_000)))
    )
    assert len(turns) == 1


async def test_no_regions_means_no_turns() -> None:
    assert await NoopDiariser().diarise(DiarisationRequest(audio_uri="a.wav")) == ()


def test_the_registry_resolves_to_the_noop_without_a_gpu_endpoint() -> None:
    assert DiariserRegistry.default().resolve().name == "noop-single-speaker"


def test_pyannote_records_the_model_and_its_licence() -> None:
    """D13 names community-1 and CC-BY-4.0; attribution is a shipping requirement."""
    assert PyannoteCommunityDiariser.model == "pyannote/speaker-diarization-community-1"
    assert PyannoteCommunityDiariser.licence == "CC-BY-4.0"
    assert PyannoteCommunityDiariser.global_labels is True
    assert "CC-BY-4.0" in PyannoteCommunityDiariser.attribution


def test_pyannote_without_a_gpu_endpoint_says_so() -> None:
    assert "GPU_PROVIDER_URL" in str(PyannoteCommunityDiariser().available())


def test_an_empty_diariser_registry_is_an_error() -> None:
    with pytest.raises(DiarisationUnavailableError):
        DiariserRegistry(diarisers=()).resolve()


def test_diariser_describe_reports_the_chain() -> None:
    rows = DiariserRegistry.default().describe()
    assert [row["name"] for row in rows] == ["pyannote-community-1", "noop-single-speaker"]
    assert rows[0]["available"] is False
    assert rows[1]["available"] is True
