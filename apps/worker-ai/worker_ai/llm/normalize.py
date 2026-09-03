"""Small-model output normalisation (M20 increment 2b).

Small local models (qwen2.5:3b via Ollama) often return JSON that is
*almost* schema-valid: a chapter title a few characters over the 60-char cap,
an optional field spelled out as ``null`` instead of omitted, a hashtag list
one entry short. Applying a few deterministic, conservative repairs to the
raw JSON dict *before* it reaches :func:`worker_ai.llm.schemas.validate_output`
recovers most of these without ever inventing content: every repair here
either removes something the model already said (a ``null``, the tail of an
over-cap string) or is a no-op. `service.py` calls this only on the Ollama
path -- a hosted model's output is validated as-is, unchanged from before
this module existed.
"""

from __future__ import annotations

from typing import Any

__all__ = ["normalize_insight_output", "strip_nulls", "truncate_word_boundary"]


def strip_nulls(value: Any) -> Any:
    """Recursively drop any dict key whose value is ``None``.

    A ``null`` list *entry* is left alone -- dropping it would silently shift
    the indices other fields (keyphrase ordering, `startMs`/`endMs` pairing)
    may depend on, which is a worse failure than the one it would "fix".
    """
    if isinstance(value, dict):
        return {key: strip_nulls(entry) for key, entry in value.items() if entry is not None}
    if isinstance(value, list):
        return [strip_nulls(entry) for entry in value]
    return value


def truncate_word_boundary(text: str, max_len: int) -> str:
    """Truncate ``text`` to at most ``max_len`` characters, backing off to the
    last whitespace within budget so a cut never lands mid-word. Falls back to
    a hard cut when the word-boundary trim would empty the string.
    """
    if len(text) <= max_len:
        return text
    hard_cut = text[:max_len]
    last_space = hard_cut.rfind(" ")
    trimmed = hard_cut[:last_space] if last_space > 0 else hard_cut
    trimmed = trimmed.rstrip()
    return trimmed if trimmed else hard_cut.rstrip()


def _truncate_field(obj: dict[str, Any], key: str, max_len: int) -> None:
    value = obj.get(key)
    if isinstance(value, str) and len(value) > max_len:
        obj[key] = truncate_word_boundary(value, max_len)


def _truncate_list_field(obj: dict[str, Any], key: str, max_len: int) -> None:
    value = obj.get(key)
    if isinstance(value, list):
        obj[key] = [
            truncate_word_boundary(item, max_len)
            if isinstance(item, str) and len(item) > max_len
            else item
            for item in value
        ]


def normalize_insight_output(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Apply the per-kind repairs, mirroring the caps in `schemas.py`.

    ``chapters.title`` <= 60, ``summary.{short,medium,long}`` <=
    240/600/1200, each platform's ``hooks`` <= 120 and ``titles`` <= 100,
    ``keyphrases.phrase`` <= 80 -- exactly the `pydantic` `Field(max_length=)`
    values those models already enforce. ``music-mood`` has no string field
    to truncate, so only `strip_nulls` applies.
    """
    stripped = strip_nulls(raw)
    if not isinstance(stripped, dict):
        return raw

    if kind == "chapters":
        chapters = stripped.get("chapters")
        if isinstance(chapters, list):
            for chapter in chapters:
                if isinstance(chapter, dict):
                    _truncate_field(chapter, "title", 60)
    elif kind == "summary":
        _truncate_field(stripped, "short", 240)
        _truncate_field(stripped, "medium", 600)
        _truncate_field(stripped, "long", 1_200)
    elif kind == "hooks":
        for platform in ("youtube", "instagram", "tiktok"):
            variant = stripped.get(platform)
            if isinstance(variant, dict):
                _truncate_list_field(variant, "hooks", 120)
                _truncate_list_field(variant, "titles", 100)
    elif kind == "keyphrases":
        keyphrases = stripped.get("keyphrases")
        if isinstance(keyphrases, list):
            for keyphrase in keyphrases:
                if isinstance(keyphrase, dict):
                    _truncate_field(keyphrase, "phrase", 80)

    return stripped
