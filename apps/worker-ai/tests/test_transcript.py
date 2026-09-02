"""Stable word ids and chunk assembly (CONTRACTS section 2)."""

from __future__ import annotations

import pytest

from worker_ai.chunking import ChunkPlanEntry
from worker_ai.providers.base import Word
from worker_ai.transcript import assemble_chunk, identity_post_process, word_id

CHUNK_0 = ChunkPlanEntry(chunk_idx=0, start_ms=0, end_ms=10_000)
CHUNK_1 = ChunkPlanEntry(chunk_idx=1, start_ms=10_000, end_ms=20_000)


def test_word_ids_have_the_contract_shape() -> None:
    assert word_id(0, 0) == "0:0"
    assert word_id(12, 431) == "12:431"


@pytest.mark.parametrize(("chunk_idx", "index"), [(-1, 0), (0, -1)])
def test_word_ids_refuse_negative_components(chunk_idx: int, index: int) -> None:
    with pytest.raises(ValueError, match="non-negative"):
        word_id(chunk_idx, index)


def test_numbering_restarts_in_every_chunk() -> None:
    """`n` is chunk-local, so re-transcribing one chunk cannot renumber another."""
    first = assemble_chunk(
        CHUNK_0,
        [Word(s=0, e=400, t="toh"), Word(s=500, e=900, t="aaj")],
        language="hi-en",
    )
    second = assemble_chunk(
        CHUNK_1,
        [Word(s=10_100, e=10_500, t="hum"), Word(s=10_600, e=11_000, t="baat")],
        language="hi-en",
    )

    assert [word["wid"] for word in first.words] == ["0:0", "0:1"]
    assert [word["wid"] for word in second.words] == ["1:0", "1:1"]
    assert first.next_word_seq == 2


def test_timings_are_monotonic_and_carried_through_verbatim() -> None:
    chunk = assemble_chunk(
        CHUNK_0,
        [Word(s=0, e=400, t="toh", c=0.91), Word(s=500, e=900, t="aaj")],
        language="hi-en",
    )
    assert [(word["s"], word["e"]) for word in chunk.words] == [(0, 400), (500, 900)]
    assert chunk.words[0]["c"] == 0.91
    # Optional fields are omitted rather than nulled: the EDG word type has them
    # optional and a null would fail the API's schema.
    assert "c" not in chunk.words[1]
    assert "sp" not in chunk.words[0]
    assert "filler" not in chunk.words[0]


def test_words_out_of_order_are_sorted_before_they_are_numbered() -> None:
    """Ids are positional, so an out-of-order provider must not poison them."""
    chunk = assemble_chunk(
        CHUNK_0,
        [Word(s=500, e=900, t="aaj"), Word(s=0, e=400, t="toh")],
        language="hi-en",
    )
    assert [word["t"] for word in chunk.words] == ["toh", "aaj"]
    assert [word["wid"] for word in chunk.words] == ["0:0", "0:1"]


def test_a_word_running_past_the_chunk_is_clamped_not_dropped() -> None:
    chunk = assemble_chunk(CHUNK_0, [Word(s=9_800, e=10_400, t="mein")], language="hi-en")
    assert chunk.words[0]["s"] == 9_800
    assert chunk.words[0]["e"] == 10_000


def test_empty_words_are_dropped_and_the_ids_stay_dense() -> None:
    chunk = assemble_chunk(
        CHUNK_0,
        [Word(s=0, e=100, t="toh"), Word(s=200, e=300, t="   "), Word(s=400, e=500, t="aaj")],
        language="hi-en",
    )
    assert [word["wid"] for word in chunk.words] == ["0:0", "0:1"]
    assert [word["t"] for word in chunk.words] == ["toh", "aaj"]


def test_speaker_scripts_and_filler_survive_assembly() -> None:
    word = Word(s=0, e=100, t="matlab", sp="S2", scripts={"native": "मतलब"}, filler=True)
    chunk = assemble_chunk(CHUNK_0, [word], language="hi-en")
    assert chunk.words[0]["sp"] == "S2"
    assert chunk.words[0]["scripts"] == {"native": "मतलब"}
    assert chunk.words[0]["filler"] is True


def test_the_post_process_hook_is_called_and_can_rewrite_words() -> None:
    """A11 replaces the identity with punctuation, numerals and filler tagging."""
    seen: list[str] = []

    def upper(words: tuple[Word, ...], language: str) -> tuple[Word, ...]:
        seen.append(language)
        return tuple(Word(s=word.s, e=word.e, t=word.t.upper(), c=word.c) for word in words)

    chunk = assemble_chunk(
        CHUNK_0, [Word(s=0, e=100, t="toh")], language="hi-en", post_process=upper
    )
    assert seen == ["hi-en"]
    assert chunk.words[0]["t"] == "TOH"


def test_the_default_post_process_changes_nothing() -> None:
    words = (Word(s=0, e=100, t="toh"),)
    assert identity_post_process(words, "hi-en") is words


def test_the_wire_shape_matches_transcript_chunks() -> None:
    chunk = assemble_chunk(CHUNK_1, [Word(s=10_000, e=10_400, t="hum")], language="hi-en")
    assert chunk.to_wire() == {
        "chunkIdx": 1,
        "startMs": 10_000,
        "endMs": 20_000,
        "nextWordSeq": 1,
        "words": [{"wid": "1:0", "s": 10_000, "e": 10_400, "t": "hum"}],
    }


def test_shifting_a_word_moves_both_edges() -> None:
    word = Word(s=100, e=400, t="toh", scripts={"native": "तो"}).shifted(10_000)
    assert (word.s, word.e) == (10_100, 10_400)
    assert word.scripts == {"native": "तो"}
