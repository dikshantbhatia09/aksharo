"""`worker_ai.llm.normalize` (M20 increment 2b): small-model output repairs
applied to the raw JSON dict before schema validation, on the Ollama path
only.
"""

from __future__ import annotations

from worker_ai.llm.normalize import normalize_insight_output, strip_nulls, truncate_word_boundary


def test_strip_nulls_drops_none_valued_keys_recursively() -> None:
    raw = {"a": 1, "b": None, "c": {"d": None, "e": 2}, "f": [{"g": None, "h": 3}]}
    assert strip_nulls(raw) == {"a": 1, "c": {"e": 2}, "f": [{"h": 3}]}


def test_strip_nulls_leaves_a_null_list_entry_alone() -> None:
    # A `null` array *entry* is not a "missing optional field" -- dropping it
    # would shift indices other fields might depend on.
    raw = {"items": [1, None, 3]}
    assert strip_nulls(raw) == {"items": [1, None, 3]}


def test_truncate_word_boundary_leaves_short_text_untouched() -> None:
    assert truncate_word_boundary("short", 60) == "short"


def test_truncate_word_boundary_backs_off_to_the_last_space() -> None:
    text = "a" * 55 + " overflow-word-that-is-long"
    result = truncate_word_boundary(text, 60)
    assert len(result) <= 60
    assert result == "a" * 55


def test_truncate_word_boundary_hard_cuts_when_no_space_in_budget() -> None:
    text = "a" * 100
    result = truncate_word_boundary(text, 60)
    assert result == "a" * 60


def test_truncate_word_boundary_never_returns_empty_for_nonempty_input() -> None:
    text = "supercalifragilisticexpialidocious-and-then-some-more-words"
    result = truncate_word_boundary(text[:10], 5)
    assert result != ""


def test_normalize_chapters_truncates_over_cap_titles() -> None:
    raw = {
        "chapters": [
            {"startMs": 0, "title": "x" * 80},
            {"startMs": 1000, "title": "short title"},
        ]
    }
    normalized = normalize_insight_output("chapters", raw)
    assert len(normalized["chapters"][0]["title"]) <= 60
    assert normalized["chapters"][1]["title"] == "short title"


def test_normalize_summary_truncates_each_field_to_its_own_cap() -> None:
    raw = {"short": "s" * 300, "medium": "m" * 700, "long": "l" * 1_300}
    normalized = normalize_insight_output("summary", raw)
    assert len(normalized["short"]) <= 240
    assert len(normalized["medium"]) <= 600
    assert len(normalized["long"]) <= 1_200


def test_normalize_hooks_truncates_hooks_and_titles_per_platform() -> None:
    variant = {
        "hooks": ["h" * 200] * 5,
        "titles": ["t" * 200] * 5,
        "hashtags": ["#a"] * 10,
    }
    raw = {"youtube": variant, "instagram": variant, "tiktok": dict(variant)}
    normalized = normalize_insight_output("hooks", raw)
    for platform in ("youtube", "instagram", "tiktok"):
        assert all(len(h) <= 120 for h in normalized[platform]["hooks"])
        assert all(len(t) <= 100 for t in normalized[platform]["titles"])


def test_normalize_keyphrases_truncates_over_cap_phrases() -> None:
    raw = {"keyphrases": [{"phrase": "p" * 100, "startMs": 0, "endMs": 1000}]}
    normalized = normalize_insight_output("keyphrases", raw)
    assert len(normalized["keyphrases"][0]["phrase"]) <= 80


def test_normalize_music_mood_only_strips_nulls() -> None:
    raw = {"scores": [{"index": 0, "sentiment": 0.5, "extra": None}]}
    normalized = normalize_insight_output("music-mood", raw)
    assert normalized == {"scores": [{"index": 0, "sentiment": 0.5}]}


def test_normalize_is_a_no_op_for_already_valid_output() -> None:
    raw = {"chapters": [{"startMs": 0, "title": "Intro"}]}
    assert normalize_insight_output("chapters", raw) == raw
