"""``ai.highlights``: the whole video is looked at, and nothing is invented.

Each test here pins a failure of the first version (the clips-pipeline audit of
2026-09-26): candidates only ever came from the first minute or two, the danda
was not a sentence end, an overlong sentence was dropped, a failed words fetch
became a made-up "Key Video Highlight", and titles lost their vowel signs.
"""

from __future__ import annotations

import math
import threading
import time
import unicodedata
from collections import Counter
from collections.abc import Sequence
from itertools import pairwise
from typing import Any

import pytest

from worker_ai.callbacks import CallbackError
from worker_ai.highlights import HighlightsOptions, HighlightsResult
from worker_ai.highlights.scoring import WordFeatures, score
from worker_ai.highlights.windows import (
    WINDOW_BUDGET,
    Window,
    Word,
    build_units,
    enumerate_windows,
    usable_words,
)
from worker_ai.processors import JobFailureError
from worker_ai.processors.highlights import (
    HIGHLIGHT_MODEL,
    UntimedTranscriptError,
    discover,
    process_highlights,
)

from .conftest import MEDIA_ID, PROJECT_ID, WORKSPACE_ID
from .test_processors import RecordingCallbacks, context_for
from .test_processors import build_services as build_test_services

RUN_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VE"
TRANSCRIPT_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VF"
MINUTE = 60_000

NEUTRAL = (
    "we walked to the market and then we came back home after that.",
    "the weather was fine and the road was quiet for most of the day.",
    "after lunch we sat outside and talked about the plans for next week.",
)


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


def talk(
    sentences: Sequence[str],
    *,
    start_ms: int = 0,
    word_ms: int = 330,
    word_gap_ms: int = 70,
    sentence_gap_ms: int = 450,
    prefix: str = "w",
) -> list[dict[str, Any]]:
    """Words as the API's `/internal/transcripts/{id}/words` sends them."""
    words: list[dict[str, Any]] = []
    clock = start_ms
    for sentence in sentences:
        for token in sentence.split():
            words.append(
                {
                    "wid": f"{prefix}{len(words) + 1:05d}",
                    "text": token,
                    "startMs": clock,
                    "endMs": clock + word_ms,
                    "chunkIdx": 0,
                }
            )
            clock += word_ms + word_gap_ms
        clock += sentence_gap_ms
    return words


def talk_with_moments(total_ms: int, moments: dict[int, Sequence[str]]) -> list[dict[str, Any]]:
    """Neutral sentences for ``total_ms``, with the given sentences placed at the given times."""
    sentences: list[str] = []
    clock = 0
    pending = sorted(moments.items())
    step = 0
    while clock < total_ms:
        if pending and pending[0][0] <= clock:
            _, placed = pending.pop(0)
            chosen = list(placed)
        else:
            chosen = [NEUTRAL[step % len(NEUTRAL)]]
            step += 1
        for sentence in chosen:
            sentences.append(sentence)
            clock += len(sentence.split()) * 400 + 450
    return talk(sentences)


def payload(**options: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "runId": RUN_ID,
        "projectId": PROJECT_ID,
        "transcriptId": TRANSCRIPT_ID,
        "transcriptRevision": 2,
        "proxy": {
            "bucket": "s3",
            "key": f"ws/{WORKSPACE_ID}/p/{PROJECT_ID}/media/{MEDIA_ID}/proxy540.mp4",
        },
        "waveform": None,
        "options": {
            "count": 5,
            "minDurationMs": 15_000,
            "maxDurationMs": 60_000,
            "contentGoal": "reach",
            "language": "hi-Latn",
            **options,
        },
        "promptVersion": "highlights-v1",
        "featureVersion": "features-v1",
    }


def options(**overrides: Any) -> HighlightsOptions:
    return HighlightsOptions.model_validate(payload(**overrides)["options"])


class TranscriptApi(RecordingCallbacks):
    """The API's words endpoint, answering with a fixed body or failing."""

    def __init__(self, response: object = None, *, error: Exception | None = None) -> None:
        super().__init__()
        self.response = response
        self.error = error
        self.requests: list[tuple[str, str, int | None]] = []

    async def get_transcript_words(
        self, transcript_id: str, attempt_id: str, revision: int | None = None
    ) -> dict[str, Any]:
        self.requests.append((transcript_id, attempt_id, revision))
        if self.error is not None:
            raise self.error
        return self.response  # type: ignore[return-value]


def words_response(words: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "transcriptId": TRANSCRIPT_ID,
        "projectId": PROJECT_ID,
        "revision": 2,
        "durationMs": max((word["endMs"] for word in words), default=0),
        "words": words,
    }


async def run(api: TranscriptApi, **option_overrides: Any) -> dict[str, Any]:
    services = build_test_services()
    object.__setattr__(services, "callbacks", api)
    context = context_for("ai.highlights", services, **payload(**option_overrides))
    outcome = await process_highlights(context)
    assert outcome is not None
    # Whatever the worker sends must parse as the contract, as the API parses it.
    HighlightsResult.model_validate(outcome.result)
    return outcome.result


async def discover_in(words: list[dict[str, Any]], **option_overrides: Any) -> dict[str, Any]:
    return await run(TranscriptApi(words_response(words)), **option_overrides)


def third_of(proposal: dict[str, Any], start_ms: int, end_ms: int) -> int:
    midpoint = (proposal["startMs"] + proposal["endMs"]) / 2
    return min(2, int((midpoint - start_ms) // ((end_ms - start_ms) / 3)))


def words_by_id(words: list[dict[str, Any]]) -> dict[str, int]:
    return {word["wid"]: index for index, word in enumerate(words)}


# ---------------------------------------------------------------------------
# The whole video
# ---------------------------------------------------------------------------

STRONG_AT_12 = (
    "Did you know that 90 percent of people in India never check this?",
    "Honestly it is the biggest mistake and Google knows it!",
)
STRONG_AT_16 = (
    "Why do 3 million people still ignore what Amazon told them?",
    "This is the truth that nobody wants to hear!",
)


async def test_an_18_minute_talk_gets_its_best_moments_from_late_in_the_video() -> None:
    """The first version returned the first N sentence windows, all in the first 90 s."""
    words = talk_with_moments(18 * MINUTE, {12 * MINUTE: STRONG_AT_12, 16 * MINUTE: STRONG_AT_16})

    result = await discover_in(words)

    proposals = result["proposals"]
    assert len(proposals) == 5
    top_two = sorted(p["startMs"] for p in proposals[:2])
    assert 11 * MINUTE < top_two[0] < 13 * MINUTE
    assert 15 * MINUTE < top_two[1] < 17 * MINUTE
    assert any(p["startMs"] > 10 * MINUTE for p in proposals)
    # Best first (the API ranks by arrival order), which is not time order here.
    starts = [p["startMs"] for p in proposals]
    assert starts != sorted(starts)


async def test_picks_are_spread_across_the_thirds_of_the_video() -> None:
    """At most ceil(count / 2) picks in any third while other thirds have material."""
    words = talk_with_moments(15 * MINUTE, {})

    result = await discover_in(words, count=6)

    proposals = result["proposals"]
    assert len(proposals) == 6
    thirds = Counter(third_of(p, words[0]["startMs"], words[-1]["endMs"]) for p in proposals)
    assert set(thirds) == {0, 1, 2}
    assert max(thirds.values()) <= math.ceil(6 / 2)


async def test_one_strong_stretch_does_not_take_every_pick() -> None:
    """The ceil(count / 2) cap binds when one third has all the best material.

    Uniform content spreads on the spread penalty alone, so it cannot show the
    cap working: here every strong moment is in the first five minutes, and
    they outscore the rest of the talk by far more than that penalty.
    """
    strong: dict[int, Sequence[str]] = {
        m * MINUTE: STRONG_AT_12 if m % 2 == 0 else STRONG_AT_16 for m in range(5)
    }
    words = talk_with_moments(15 * MINUTE, strong)

    proposals = (await discover_in(words, count=5))["proposals"]

    assert len(proposals) == 5
    thirds = Counter(third_of(p, words[0]["startMs"], words[-1]["endMs"]) for p in proposals)
    assert thirds[0] == math.ceil(5 / 2)
    assert thirds[1] + thirds[2] == 2


async def test_picks_never_overlap() -> None:
    words = talk_with_moments(8 * MINUTE, {3 * MINUTE: STRONG_AT_12, 3 * MINUTE + 1: STRONG_AT_16})

    proposals = (await discover_in(words, count=10))["proposals"]

    spans = sorted((p["startMs"], p["endMs"]) for p in proposals)
    for (_, end), (start, _) in pairwise(spans):
        assert end <= start


async def test_a_video_with_speech_in_one_third_still_gets_the_count() -> None:
    """The thirds limit spreads picks; it does not throw candidates away."""
    words = talk([NEUTRAL[i % 3] for i in range(60)])  # about 5.5 minutes of speech
    # One long silence after it: the video is 20 minutes, the speech all early.
    words.append(
        {"wid": "tail", "text": "bye.", "startMs": 20 * MINUTE, "endMs": 20 * MINUTE + 300}
    )

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5


async def test_windows_considered_counts_every_window_scored() -> None:
    words = talk_with_moments(6 * MINUTE, {})

    result = await discover_in(words)

    # Many more windows than the five proposed: all of them were scored.
    assert result["windowsConsidered"] > 50
    assert len({p["windowId"] for p in result["proposals"]}) == 5


# ---------------------------------------------------------------------------
# Sentences in Hindi and Hinglish
# ---------------------------------------------------------------------------

HINGLISH = (
    "aaj hum aapko ek bahut khaas jagah dikhaenge jahan log roz aate hain।",
    "ye raha aapka private pool aur uske saamne bungalow hai।",
    "yahan se samundar ka nazaara ekdum saaf dikhta hai dosto॥",
)


async def test_hinglish_sentences_ending_in_a_danda_are_sentences() -> None:
    """Sarvam's romanized Hinglish ends sentences with '।' and has no Latin full stops.

    The first version saw one ten-minute "sentence", dropped it as too long and
    fell back to the first 51 words: one candidate instead of five.
    """
    sentences = [HINGLISH[i % 3] for i in range(110)]  # about ten minutes
    words = talk(sentences)
    index = words_by_id(words)

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5
    for proposal in proposals:
        assert 15_000 <= proposal["endMs"] - proposal["startMs"] <= 60_000
        first, last = index[proposal["startWordId"]], index[proposal["endWordId"]]
        # Whole sentences: it starts after a danda and ends on one.
        assert first == 0 or words[first - 1]["text"].endswith(("।", "॥"))
        assert words[last]["text"].endswith(("।", "॥"))
    # From the whole video, not its first minute and a half.
    thirds = {third_of(p, words[0]["startMs"], words[-1]["endMs"]) for p in proposals}
    assert thirds == {0, 1, 2}


DEVANAGARI = ["नमस्ते", "दोस्तों", "आज", "हम", "बात", "करेंगे", "एक", "बहुत", "ज़रूरी", "विषय", "पर"]


def unpunctuated_devanagari(total_words: int, *, pause_every: int = 10) -> list[dict[str, Any]]:
    """Local Whisper's Hindi: Devanagari, no punctuation at all, pauses only."""
    words: list[dict[str, Any]] = []
    clock = 0
    for n in range(total_words):
        words.append(
            {
                "wid": f"d{n:05d}",
                "text": DEVANAGARI[n % len(DEVANAGARI)],
                "startMs": clock,
                "endMs": clock + 350,
            }
        )
        clock += 410
        if n % pause_every == pause_every - 1:
            clock += 900
    return words


async def test_unpunctuated_devanagari_is_split_at_its_pauses_not_dropped() -> None:
    words = unpunctuated_devanagari(900)  # about seven and a half minutes, one "sentence"
    index = words_by_id(words)

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5
    for proposal in proposals:
        assert 15_000 <= proposal["endMs"] - proposal["startMs"] <= 60_000
        first, last = index[proposal["startWordId"]], index[proposal["endWordId"]]
        # Every cut falls on a breath, not in the middle of a phrase.
        assert first == 0 or words[first]["startMs"] - words[first - 1]["endMs"] >= 700
        assert last == len(words) - 1 or words[last + 1]["startMs"] - words[last]["endMs"] >= 700


def sarvam_flat(sentences: int) -> list[dict[str, Any]]:
    """Sarvam's Hinglish as it really arrives: dandas, and no silence between words.

    In a real 6-minute Sarvam transcript the median gap between words is 0 ms.
    """
    return talk(
        [HINGLISH[i % 3] for i in range(sentences)],
        word_ms=400,
        word_gap_ms=0,
        sentence_gap_ms=0,
    )


@pytest.mark.parametrize(
    "words",
    [
        pytest.param(sarvam_flat(150), id="sarvam-hinglish-no-gaps"),
        pytest.param(unpunctuated_devanagari(900), id="devanagari-with-pauses"),
        pytest.param(unpunctuated_devanagari(900, pause_every=10**9), id="devanagari-no-pauses"),
    ],
)
async def test_the_start_and_end_of_the_video_are_not_ranked_first_for_being_edges(
    words: list[dict[str, Any]],
) -> None:
    """Openings and sign-offs won on structure alone.

    The start of a transcript scored as a perfect pause and a sentence start,
    and its end as a perfect pause and a sentence end, while every window in
    between was measured - and Sarvam leaves no silence between words, and
    unpunctuated Devanagari has no sentence starts but the first word. So on
    even content the first and last windows took ranks 1 and 2.
    """
    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5
    top = proposals[0]
    assert top["startWordId"] != words[0]["wid"]
    assert top["endWordId"] != words[-1]["wid"]


async def test_an_overlong_sentence_is_split_at_its_commas_not_dropped() -> None:
    clause = "we kept building the thing and testing it again,"
    words = talk([" ".join([clause] * 28).rstrip(",") + "."])  # one 100-second sentence
    assert words[-1]["endMs"] > 90_000

    proposals = (await discover_in(words))["proposals"]

    assert proposals
    by_id = {word["wid"]: word for word in words}
    for proposal in proposals:
        assert 15_000 <= proposal["endMs"] - proposal["startMs"] <= 60_000
        assert by_id[proposal["endWordId"]]["text"].endswith((",", "."))


# ---------------------------------------------------------------------------
# Never invent a candidate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", [None, 500, 502, 503, 429])
async def test_a_words_fetch_the_api_could_not_answer_fails_retryably(status: int | None) -> None:
    """The first version swallowed this and reported a made-up 0-30 s moment as success."""
    api = TranscriptApi(error=CallbackError("the API is restarting", status_code=status))

    with pytest.raises(JobFailureError) as raised:
        await run(api)

    assert raised.value.retryable is True
    assert raised.value.code == "worker/callback_unavailable"
    assert api.completions == []


@pytest.mark.parametrize("status", [401, 404])
async def test_a_words_fetch_the_api_refused_fails_for_good(status: int) -> None:
    api = TranscriptApi(error=CallbackError("refused", status_code=status))

    with pytest.raises(JobFailureError) as raised:
        await run(api)

    assert raised.value.retryable is False
    assert raised.value.code == "worker/transcript_unavailable"


async def test_an_unexpected_error_while_fetching_words_is_retryable() -> None:
    api = TranscriptApi(error=ValueError("Expecting value: line 1 column 1 (char 0)"))

    with pytest.raises(JobFailureError) as raised:
        await run(api)

    assert raised.value.retryable is True


@pytest.mark.parametrize("body", [{}, {"words": None}, {"words": "nope"}, None])
async def test_a_response_without_a_word_list_is_a_failure_not_an_empty_transcript(
    body: object,
) -> None:
    with pytest.raises(JobFailureError) as raised:
        await run(TranscriptApi(body))

    assert raised.value.retryable is True


async def test_a_transcript_of_another_project_is_refused() -> None:
    body = {**words_response(talk(NEUTRAL * 5)), "projectId": "01JBQ8Z2W4N7Y0K3M5P8R1T6VG"}

    with pytest.raises(JobFailureError) as raised:
        await run(TranscriptApi(body))

    assert raised.value.retryable is False


async def test_a_transcript_the_api_does_not_know_is_a_failure_not_a_silent_video() -> None:
    """The words endpoint answers an unknown transcript with 200 and no words.

    Before, that became zero proposals and a run saying the video had no moments.
    """
    body = {"transcriptId": TRANSCRIPT_ID, "revision": 1, "words": [], "durationMs": 0}

    with pytest.raises(JobFailureError) as raised:
        await run(TranscriptApi(body))

    assert raised.value.code == "worker/transcript_unavailable"
    assert raised.value.retryable is False


async def test_the_pinned_revision_is_the_one_fetched() -> None:
    api = TranscriptApi(words_response(talk(NEUTRAL * 5)))

    await run(api)

    assert api.requests[0][0] == TRANSCRIPT_ID
    assert api.requests[0][2] == 2


async def test_a_transcript_with_no_words_gets_no_proposals() -> None:
    result = await discover_in([])

    assert result["proposals"] == []
    assert result["windowsConsidered"] == 0
    assert result["model"] == HIGHLIGHT_MODEL


def untimed_words(start_ms: int | None, end_ms: int | None) -> list[dict[str, Any]]:
    return [
        {"wid": f"z{n}", "text": "shabd", "startMs": start_ms, "endMs": end_ms} for n in range(400)
    ]


@pytest.mark.parametrize(
    ("start_ms", "end_ms"),
    [
        pytest.param(0, 0, id="every-word-at-0-0"),  # Sarvam before 2026-09-17 (§9)
        pytest.param(None, None, id="no-timing-at-all"),
    ],
)
async def test_words_without_usable_timing_fail_the_job_rather_than_find_no_moment(
    start_ms: int | None, end_ms: int | None
) -> None:
    """An empty answer here made the run say "no moment worth suggesting".

    That blamed the video for what transcribing it again fixes, so the run has
    to fail with a code whose page names that remedy.
    """
    api = TranscriptApi({**words_response([]), "words": untimed_words(start_ms, end_ms)})

    with pytest.raises(JobFailureError) as raised:
        await run(api)

    assert raised.value.code == "worker/transcript_untimed"
    # The same words give the same answer: running it again cannot help.
    assert raised.value.retryable is False
    assert api.completions == []


def test_discover_names_an_untimed_transcript_instead_of_answering_empty() -> None:
    with pytest.raises(UntimedTranscriptError) as raised:
        discover(untimed_words(0, 0), options())

    assert (raised.value.spoken, raised.value.timed) == (400, 0)


@pytest.mark.parametrize(
    "wid", ["", "   ", "x" * 101, None], ids=["empty", "blank", "long", "none"]
)
def test_a_malformed_id_is_not_reported_as_a_missing_timing(wid: str | None) -> None:
    """Well-timed speech that nothing can cite is not an untimed transcript.

    The untimed check counted every speech item against the timed words it
    could cite, so these words - timed perfectly - failed the run and sent the
    user to transcribe again, which would not have changed them.
    """
    words = [{**word, "wid": wid} for word in talk(NEUTRAL * 10)]

    assert discover(words, options()) == ([], 0)


def test_words_with_a_malformed_id_do_not_outvote_the_timed_ones() -> None:
    """Twice as many uncitable words as good ones used to fail the whole run as untimed."""
    cited = talk(NEUTRAL * 10)
    uncited = [{**word, "wid": "x" * 101} for word in talk(NEUTRAL * 20)]
    expected = discover(cited, options())
    assert len(expected[0]) == 5  # a real answer, not two empty ones agreeing

    assert discover(cited + uncited, options()) == expected


async def test_a_few_zero_length_words_do_not_make_a_transcript_untimed() -> None:
    """Aligners produce the odd zero-length word; a third of them is still a timed talk."""
    words = talk([NEUTRAL[i % 3] for i in range(40)])
    for word in words[::3]:
        word["endMs"] = word["startMs"]

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5


def music(count: int, *, start_ms: int = 0, step_ms: int = 700) -> list[dict[str, Any]]:
    """What Whisper writes over a song: note symbols and sound labels, timed like words."""
    marks = ("♪", "\U0001f3b5", "[Music]", "♪♪")
    return [
        {
            "wid": f"m{n:05d}",
            "text": marks[n % len(marks)],
            "startMs": start_ms + n * step_ms,
            "endMs": start_ms + n * step_ms + step_ms - 50,
        }
        for n in range(count)
    ]


async def test_a_music_only_transcript_gets_no_proposals() -> None:
    """Before, two 'Moment at 0:00' candidates quoting '.' came back: nothing was said."""
    result = await discover_in(music(400))

    assert result["proposals"] == []


async def test_music_around_the_speech_is_neither_cut_nor_quoted() -> None:
    """A song intro is not speech time, and it does not make the talk "untimed" either.

    More note tokens than words used to trip the check for transcripts
    without usable timing, which is a rule about words, not about notes.
    """
    intro = music(600)  # seven minutes of song, then the talk
    speech_start = intro[-1]["endMs"] + 1_000
    words = intro + talk([NEUTRAL[i % 3] for i in range(40)], start_ms=speech_start)

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 5
    for proposal in proposals:
        assert proposal["startMs"] >= speech_start
        assert not proposal["startWordId"].startswith("m")
        assert "♪" not in proposal["transcriptExcerpt"]
        assert "[Music]" not in proposal["transcriptExcerpt"]


def test_a_mark_written_as_its_own_token_still_ends_the_sentence() -> None:
    """Dropping symbol-only tokens must not drop a danda that arrived on its own."""
    raw: list[object] = [
        {"wid": "a", "text": "hain", "startMs": 0, "endMs": 300},
        {"wid": "b", "text": "।", "startMs": 300, "endMs": 310},
        {"wid": "c", "text": "♪", "startMs": 400, "endMs": 900},
        {"wid": "d", "text": "ye", "startMs": 1000, "endMs": 1200},
    ]

    assert [(word.wid, word.text) for word in usable_words(raw)] == [
        ("a", "hain।"),
        ("d", "ye"),
    ]


async def test_a_source_shorter_than_the_minimum_gets_no_proposal() -> None:
    """The requested length is respected; a 10 s video has no 15 s moment in it."""
    words = talk(["this whole video is only a few seconds long and then it ends."])
    assert words[-1]["endMs"] < 15_000

    assert (await discover_in(words))["proposals"] == []


async def test_speech_islands_get_windows_of_the_requested_length_holding_only_their_words() -> (
    None
):
    """No window fits between min and max, so the fallback pads each island with its silence.

    The first version took the first 51 words however far apart they were: a
    three-minute candidate of mostly silence whose excerpt quoted words that
    were not in the cut.
    """
    first_island = talk([NEUTRAL[0], NEUTRAL[2]], start_ms=1 * MINUTE, prefix="a")
    second_island = talk([NEUTRAL[1], NEUTRAL[0]], start_ms=9 * MINUTE, prefix="b")
    words = first_island + second_island
    index = words_by_id(words)

    proposals = (await discover_in(words))["proposals"]

    assert len(proposals) == 2
    for proposal in proposals:
        assert 15_000 <= proposal["endMs"] - proposal["startMs"] <= 60_000
        first, last = index[proposal["startWordId"]], index[proposal["endWordId"]]
        cited = words[first : last + 1]
        # Every word in the cut is quoted, and every quoted word is in the cut.
        in_cut = [
            w
            for w in words
            if w["endMs"] > proposal["startMs"] and w["startMs"] < proposal["endMs"]
        ]
        assert in_cut == cited
        assert proposal["transcriptExcerpt"] == " ".join(w["text"] for w in cited)


async def test_a_single_word_is_not_padded_into_a_moment() -> None:
    words = [{"wid": "only", "text": "hello.", "startMs": 5_000, "endMs": 5_400}]
    words += talk([NEUTRAL[0], NEUTRAL[1]], start_ms=10 * MINUTE)

    proposals = (await discover_in(words))["proposals"]

    # The ten-second island is padded to fifteen; the lone word is not.
    assert len(proposals) == 1
    assert proposals[0]["startWordId"] != "only"


# ---------------------------------------------------------------------------
# Scores
# ---------------------------------------------------------------------------


async def test_discovery_is_deterministic() -> None:
    words = talk_with_moments(12 * MINUTE, {7 * MINUTE: STRONG_AT_12})

    first = await discover_in(words)
    again = await discover_in(words)
    # Interleaved: every word out of place, which the time sort has to undo.
    reordered = await discover_in(words[1::2] + words[::2])

    assert first == again == reordered


async def test_scores_differ_rank_best_first_and_stay_in_range() -> None:
    words = talk_with_moments(12 * MINUTE, {4 * MINUTE: STRONG_AT_12, 9 * MINUTE: STRONG_AT_16})

    proposals = (await discover_in(words))["proposals"]

    scores = [p["potentialScore"] for p in proposals]
    assert scores == sorted(scores, reverse=True)
    assert len(set(scores)) > 1
    assert all(0 <= s <= 100 for s in scores)
    for proposal in proposals:
        assert all(0 <= v <= 100 for v in proposal["scoreBreakdown"].values())
    # The strong moments carry the evidence for their rank.
    labels = {reason["label"] for reason in proposals[0]["reasons"]}
    assert {"hook", "novelty", "emotion"} <= labels


def _signals_for(sentences: Sequence[str]) -> Any:
    words = usable_words(talk(sentences))
    features = WordFeatures(words)
    return features.signals(0, len(words) - 1, words[0].start_ms, words[-1].end_ms)


def test_a_hook_opener_scores_higher_than_the_same_words_without_it() -> None:
    plain = _signals_for(["most of the time the market is quiet in the evening."])
    hooked = _signals_for(["did you know the market is quiet in the evening?"])

    assert score(hooked, "reach").potential > score(plain, "reach").potential
    assert hooked.opener == "did you know"


@pytest.mark.parametrize(
    ("sentence", "opener"),
    [
        ("show me the numbers from last year.", None),
        ("however the road was closed.", None),
        ("how do you fix it?", "how"),
        ("so, here's the thing about it.", "here's"),
        ("kya aapko pata hai ye kya hai।", "kya aapko"),
        ("क्या आप जानते हैं।", "क्या आप"),
    ],
)
def test_openers_match_whole_words(sentence: str, opener: str | None) -> None:
    """The first version's substring test found "how" inside "show" and "however"."""
    assert _signals_for([sentence]).opener == opener


def test_fillers_and_dead_air_lower_clarity() -> None:
    fluent = _signals_for(["we fixed the build and shipped the release on time."])
    halting = _signals_for(["um we uh fixed the um build and uh shipped it."])

    assert score(halting, "reach").clarity < score(fluent, "reach").clarity


async def test_the_content_goal_changes_what_ranks_first() -> None:
    hook = (
        "Did you know this is the biggest mistake people make?",
        "Honestly nobody ever talks about it and it is shocking!",
    )
    facts = (
        "In 2019 Infosys hired 25000 engineers in Bangalore and Pune.",
        "By 2023 TCS and Wipro had doubled that to 50000 in Chennai.",
    )
    words = talk_with_moments(10 * MINUTE, {2 * MINUTE: hook, 7 * MINUTE: facts})

    reach = (await discover_in(words, contentGoal="reach"))["proposals"][0]
    authority = (await discover_in(words, contentGoal="authority"))["proposals"][0]

    assert reach["startMs"] < 5 * MINUTE < authority["startMs"]


async def test_the_model_names_the_new_ranking() -> None:
    result = await discover_in(talk(NEUTRAL * 5))

    assert result["model"] == HIGHLIGHT_MODEL == "montaj-highlight-v2"


# ---------------------------------------------------------------------------
# What a proposal cites
# ---------------------------------------------------------------------------


async def test_word_ids_and_times_are_the_cited_words_own() -> None:
    words = talk_with_moments(6 * MINUTE, {2 * MINUTE: STRONG_AT_12})
    by_id = {word["wid"]: word for word in words}

    for proposal in (await discover_in(words))["proposals"]:
        assert by_id[proposal["startWordId"]]["startMs"] == proposal["startMs"]
        assert by_id[proposal["endWordId"]]["endMs"] == proposal["endMs"]
        assert proposal["windowId"].startswith("w-")


async def test_hindi_titles_keep_every_vowel_sign() -> None:
    """`re.sub(r"[^\\w\\s-]")` deleted matras and the virama: 'नमस्ते' became 'नमसत'."""
    sentence = "नमस्ते दोस्तों आज हम बात करेंगे एक बहुत ज़रूरी विषय पर।"
    words = talk([sentence] * 40)
    # NFC on both sides: `ज़` may be precomposed here and is canonically decomposed there.
    source = set(unicodedata.normalize("NFC", sentence).rstrip("।").split())

    proposals = (await discover_in(words))["proposals"]

    assert proposals
    for proposal in proposals:
        title = proposal["title"].rstrip("…")
        assert title.startswith("नमस्ते दोस्तों आज हम बात करेंगे")
        assert set(title.split()) <= source


async def test_english_titles_keep_apostrophes_and_their_own_case() -> None:
    sentence = "it's an editorial team's worth of work done by one AI model."
    words = talk([sentence] * 30)

    proposals = (await discover_in(words))["proposals"]

    assert proposals[0]["title"] == "It's an editorial team's worth of work done by one AI model"


def test_usable_words_skips_what_cannot_be_cited_and_orders_by_time() -> None:
    raw: list[object] = [
        {"wid": "b", "text": "second", "startMs": 500, "endMs": 900},
        {"wid": "a", "text": "first", "startMs": 0, "endMs": 400},
        {"wid": "", "text": "no id", "startMs": 1000, "endMs": 1100},
        {"wid": "c", "text": "   ", "startMs": 1000, "endMs": 1100},
        {"wid": "d", "text": "backwards", "startMs": 1000, "endMs": 900},
        {"wid": "e", "text": "negative", "startMs": -5, "endMs": 10},
        {"wid": "f", "text": "untimed", "startMs": None, "endMs": 10},
        {"wid": "g", "text": "bool", "startMs": True, "endMs": 10},
        "not a word",
    ]

    assert [word.wid for word in usable_words(raw)] == ["a", "b"]


def test_discover_is_usable_without_a_job() -> None:
    """Pure: the same function the processor calls, for offline evaluation."""
    proposals, considered = discover(talk(NEUTRAL * 10), options(count=2))

    assert len(proposals) == 2
    assert considered >= 2


# ---------------------------------------------------------------------------
# Long sources
# ---------------------------------------------------------------------------

SHORT_SENTENCES = ("yes that works.", "okay go on.", "right then so.")


def six_hours_of_short_sentences() -> list[dict[str, Any]]:
    """Six hours (the Studio plan's limit) of three-word sentences.

    With the widest bounds the run DTO accepts, every start has about a
    hundred ends: a million windows, which took 49 s and about 1 GB before.
    """
    sentence_ms = 3 * 400 + 450
    return talk([SHORT_SENTENCES[i % 3] for i in range(6 * 60 * MINUTE // sentence_ms)])


def test_a_six_hour_stream_of_short_sentences_is_scored_within_the_budget() -> None:
    words = usable_words(six_hours_of_short_sentences())
    units = build_units(words, min_ms=3_000, max_ms=180_000)

    windows = enumerate_windows(units, min_ms=3_000, max_ms=180_000)

    assert len(windows) <= WINDOW_BUDGET
    # Thinned, not truncated: starts still reach the end of the video, in time order.
    assert windows[-1].start_ms > words[-1].end_ms - 10 * MINUTE
    assert [w.window_id for w in windows] == sorted(w.window_id for w in windows)
    assert windows == sorted(windows, key=lambda w: (w.start_ms, w.end_ms))
    for window in windows:
        assert 3_000 <= window.end_ms - window.start_ms <= 180_000


def test_a_six_hour_stream_of_short_sentences_is_discovered_in_seconds() -> None:
    raw = six_hours_of_short_sentences()

    started = time.perf_counter()
    proposals, considered = discover(
        raw, options(count=20, minDurationMs=3_000, maxDurationMs=180_000)
    )
    elapsed = time.perf_counter() - started

    assert len(proposals) == 20
    assert considered == 10_000  # the contract's ceiling on what is reported
    assert elapsed < 12, f"took {elapsed:.1f} s"


@pytest.mark.parametrize(
    ("max_ms", "share"),
    [
        pytest.param(60_000, 4, id="fewer-starts"),  # too many starts: starts are thinned
        pytest.param(180_000, 2, id="fewer-ends"),  # starts fit, each keeps fewer ends
    ],
)
def test_when_the_budget_binds_the_cleanest_cuts_are_kept(max_ms: int, share: int) -> None:
    """Thinning keeps, from each stretch of candidates, the cut after the longest breath."""
    words: list[Word] = []
    shift = sentences = 0
    for word in usable_words(talk([NEUTRAL[i % 3] for i in range(120)])):
        words.append(Word(word.wid, word.text, word.start_ms + shift, word.end_ms + shift))
        if word.text.endswith("."):
            sentences += 1
            if sentences % 5 == 0:
                shift += 1_000  # a real breath after every fifth sentence

    def breath_before(window: Window) -> bool:
        index = next(i for i, w in enumerate(words) if w.start_ms == window.start_ms)
        return index > 0 and window.start_ms - words[index - 1].end_ms >= 1_000

    def breath_after(window: Window) -> bool:
        index = next(i for i, w in enumerate(words) if w.end_ms == window.end_ms)
        return index + 1 < len(words) and words[index + 1].start_ms - window.end_ms >= 1_000

    units = build_units(words, min_ms=15_000, max_ms=max_ms)
    everything = enumerate_windows(units, min_ms=15_000, max_ms=max_ms)
    budget = len(everything) // share

    thinned = enumerate_windows(units, min_ms=15_000, max_ms=max_ms, budget=budget)

    def cut(window: Window) -> tuple[int, int, int, int]:
        return window.first, window.last, window.start_ms, window.end_ms

    assert 0 < len(thinned) <= budget
    assert set(map(cut, thinned)) <= set(map(cut, everything))
    clean = breath_before if max_ms == 60_000 else breath_after
    kept = sum(map(clean, thinned)) / len(thinned)
    overall = sum(map(clean, everything)) / len(everything)
    assert kept > 2 * overall


async def test_discovery_runs_off_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Seconds of CPU on the one loop every AI queue shares stalls their heartbeats."""
    from worker_ai.processors import highlights as module

    threads: list[int] = []
    real = module.discover

    def recording(*args: Any, **kwargs: Any) -> Any:
        threads.append(threading.get_ident())
        return real(*args, **kwargs)

    monkeypatch.setattr(module, "discover", recording)

    await discover_in(talk(NEUTRAL * 5))

    assert threads
    assert threads[0] != threading.get_ident()
