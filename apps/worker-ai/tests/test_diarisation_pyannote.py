"""pyannote community-1 and the speaker-to-word overlap join (D13, `09 §2`)."""

from __future__ import annotations

import json

import httpx2
import pytest

from worker_ai.diarisation.mapping import assign_speakers, parse_rttm, speaker_ids
from worker_ai.diarisation.pyannote import (
    PYANNOTE_ATTRIBUTION,
    PyannoteCommunityDiariser,
)
from worker_ai.evals.replay import load_session, replay_transport
from worker_ai.providers.base import DiarisationRequest, ProviderError, Word
from worker_ai.providers.http import VendorHttp

#: A synthetic RTTM — the format every diarisation dataset and pyannote example
#: ships, which is why the mapping tests read one rather than a list of objects.
RTTM = """
SPEAKER clip 1 0.000 2.150 <NA> <NA> S1 <NA> <NA>
SPEAKER clip 1 2.160 1.840 <NA> <NA> S2 <NA> <NA>
SPEAKER clip 1 4.100 0.900 <NA> <NA> S1 <NA> <NA>
SPKR-INFO clip 1 <NA> <NA> <NA> unknown S1 <NA> <NA>
"""


def _diariser(fixture: str = "gpu-whisper") -> tuple[PyannoteCommunityDiariser, object]:
    session = load_session(fixture)
    return (
        PyannoteCommunityDiariser(
            session.base_url,
            token="gpu-token",
            http=VendorHttp(
                provider="pyannote-community-1",
                base_url=session.base_url,
                headers={"authorization": "Bearer gpu-token"},
                client=httpx2.AsyncClient(transport=replay_transport(session)),
            ),
        ),
        session,
    )


# ---------------------------------------------------------------------------
# RTTM
# ---------------------------------------------------------------------------


def test_rttm_parses_speaker_lines_into_milliseconds() -> None:
    turns = parse_rttm(RTTM)
    assert [(turn.speaker_id, turn.start_ms, turn.end_ms) for turn in turns] == [
        ("S1", 0, 2_150),
        ("S2", 2_160, 4_000),
        ("S1", 4_100, 5_000),
    ]


def test_rttm_ignores_records_that_are_not_speaker_turns() -> None:
    assert len(parse_rttm(RTTM)) == 3
    assert parse_rttm("not an rttm at all") == ()
    assert parse_rttm("SPEAKER clip 1 x y <NA> <NA> S1 <NA> <NA>") == ()
    assert parse_rttm("SPEAKER clip 1 0.0 0.0 <NA> <NA> S1 <NA> <NA>") == ()


# ---------------------------------------------------------------------------
# The overlap join
# ---------------------------------------------------------------------------


def test_a_word_takes_the_speaker_of_the_turn_it_overlaps_most() -> None:
    turns = parse_rttm(RTTM)
    words = (
        Word(s=100, e=500, t="toh"),
        Word(s=2_000, e=2_400, t="aaj"),  # straddles S1/S2, mostly S2
        Word(s=2_500, e=2_900, t="hum"),
        Word(s=4_200, e=4_600, t="baat"),
    )
    mapping = assign_speakers(words, turns)
    assert [word.sp for word in mapping.words] == ["S1", "S2", "S2", "S1"]
    assert mapping.snapped == 0
    assert mapping.unlabelled == 0


def test_a_word_in_no_turn_takes_the_nearest_one() -> None:
    """A blank speaker mid-sentence looks more wrong than the nearest guess."""
    turns = parse_rttm(RTTM)
    # 4050-4090 sits in the 100 ms gap, 50 ms after S2 and 10 ms before S1.
    mapping = assign_speakers((Word(s=4_050, e=4_090, t="uh"),), turns)
    assert mapping.words[0].sp == "S1"
    assert mapping.snapped == 1


def test_a_word_equidistant_from_two_turns_takes_the_earlier_one() -> None:
    turns = parse_rttm(RTTM)
    mapping = assign_speakers((Word(s=4_020, e=4_080, t="uh"),), turns)
    assert mapping.words[0].sp == "S2"


def test_no_turns_leaves_the_words_unlabelled_rather_than_inventing_a_speaker() -> None:
    mapping = assign_speakers((Word(s=0, e=100, t="toh"),), ())
    assert mapping.words[0].sp is None
    assert mapping.unlabelled == 1


def test_no_words_is_not_an_error() -> None:
    assert assign_speakers((), parse_rttm(RTTM)).words == ()


def test_the_join_preserves_everything_else_on_a_word() -> None:
    word = Word(s=100, e=400, t="toh", c=0.9, scripts={"roman": "toh"}, filler=True)
    labelled = assign_speakers((word,), parse_rttm(RTTM)).words[0]
    assert (labelled.c, labelled.filler, labelled.scripts) == (0.9, True, {"roman": "toh"})


def test_speakers_are_listed_in_first_appearance_order() -> None:
    assert speaker_ids(parse_rttm(RTTM)) == ("S1", "S2")
    assert speaker_ids(()) == ()


def test_the_mapping_summary_serialises() -> None:
    mapping = assign_speakers((Word(s=0, e=100, t="a"),), parse_rttm(RTTM))
    assert mapping.to_wire() == {"words": 1, "snapped": 0, "unlabelled": 0}


# ---------------------------------------------------------------------------
# The adapter
# ---------------------------------------------------------------------------


async def test_pyannote_reads_the_model_server_and_renumbers_speakers() -> None:
    diariser, session = _diariser()
    turns = await diariser.diarise(
        DiarisationRequest(audio_uri="a.wav", num_speakers=2, min_speakers=1, max_speakers=8)
    )

    assert [turn.speaker_id for turn in turns] == ["S1", "S2"]
    assert (turns[0].start_ms, turns[0].end_ms) == (0, 2_150)
    request = next(item for item in session.seen if item.url.path == "/diarise")  # type: ignore[attr-defined]
    body = json.loads(request.content)
    assert body["model"] == "pyannote/speaker-diarization-community-1"
    assert body["numSpeakers"] == 2
    assert body["maxSpeakers"] == 8
    assert request.headers["authorization"] == "Bearer gpu-token"


async def test_pyannote_records_a_submission_for_the_audio_it_sent() -> None:
    diariser, _session = _diariser()
    await diariser.diarise(DiarisationRequest(audio_uri="a.wav"))
    assert diariser.submissions[0].to_wire()["retentionClass"] == "ephemeral"
    assert diariser.submissions[0].to_wire()["endpoint"].endswith("/diarise")


async def test_an_unreadable_turn_list_is_a_permanent_failure() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        del request
        return httpx2.Response(200, json={"turns": [{"speaker": None}]})

    diariser = PyannoteCommunityDiariser(
        "https://gpu.test",
        http=VendorHttp(
            provider="pyannote-community-1",
            base_url="https://gpu.test",
            client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        ),
    )
    with pytest.raises(ProviderError) as raised:
        await diariser.diarise(DiarisationRequest(audio_uri="a.wav"))
    assert raised.value.retryable is False


async def test_zero_length_turns_are_dropped() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        del request
        return httpx2.Response(
            200,
            json={
                "turns": [
                    {"speaker": "SPEAKER_00", "start": 1.0, "end": 1.0},
                    {"speaker": "SPEAKER_01", "start": 1.0, "end": 2.0, "confidence": 0.8},
                ]
            },
        )

    diariser = PyannoteCommunityDiariser(
        "https://gpu.test",
        http=VendorHttp(
            provider="pyannote-community-1",
            base_url="https://gpu.test",
            client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        ),
    )
    turns = await diariser.diarise(DiarisationRequest(audio_uri="a.wav"))
    assert [(turn.speaker_id, turn.confidence) for turn in turns] == [("S2", 0.8)]


def test_the_attribution_string_is_shippable() -> None:
    """CC-BY-4.0 requires attribution wherever the output ships (D13)."""
    assert "pyannote" in PYANNOTE_ATTRIBUTION
    assert "CC-BY-4.0" in PYANNOTE_ATTRIBUTION


def test_a_flag_can_switch_pyannote_off() -> None:
    diariser = PyannoteCommunityDiariser("https://gpu.test", enabled=False)
    assert "diarise.pyannote" in str(diariser.available())


def test_the_registry_prefers_pyannote_when_a_gpu_endpoint_exists() -> None:
    from worker_ai.diarisation.base import DiariserRegistry
    from worker_ai.settings import load_settings

    from .conftest import VALID_ENV

    settings = load_settings({**VALID_ENV, "GPU_PROVIDER_URL": "https://gpu.test"})
    assert DiariserRegistry.from_settings(settings).resolve().name == "pyannote-community-1"
    assert DiariserRegistry.from_settings(load_settings(VALID_ENV)).resolve().name == (
        "noop-single-speaker"
    )
