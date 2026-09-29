"""The JSON object in a model's reply, however the model wrapped it.

Every prompt in this package asks for "strict JSON only", and a hosted model in
JSON mode mostly obliges. Not always: a model without JSON mode (or one that
ignores it) answers with the object inside a Markdown fence, after a sentence of
preamble, or followed by a note. Those replies carry a perfectly good answer,
and throwing them away would send a paid call's result to the fallback for
nothing. :func:`extract_json_object` finds the first complete JSON object in the
text and nothing else: it never repairs or guesses at a broken one.
"""

from __future__ import annotations

import json
import re
from typing import Any, Final

__all__ = ["extract_json_object", "first_json_object_text"]

#: A Markdown code fence, with or without a language tag.
_FENCE: Final = re.compile(r"```[a-zA-Z0-9_-]*\s*\n?(.*?)```", re.DOTALL)
#: How many opening braces are tried before giving up. Each try scans to the
#: end of the reply, so an unbounded count would be quadratic on a reply that
#: is mostly braces; a real reply has its object within the first few.
_MAX_OPENINGS: Final[int] = 64


def _balanced_object_at(text: str, start: int) -> str | None:
    """The ``{...}`` that opens at ``start``, braces counted outside strings."""
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def first_json_object_text(text: str | None) -> str | None:
    """The text of the first JSON object in ``text`` that parses, or ``None``.

    Tried in order: the whole reply, the inside of each code fence, then every
    ``{`` in the reply from the left.
    """
    if not text:
        return None
    stripped = text.strip()
    candidates: list[str] = [stripped]
    candidates.extend(match.group(1).strip() for match in _FENCE.finditer(stripped))
    for candidate in candidates:
        if _parses_as_object(candidate):
            return candidate
    openings = 0
    position = stripped.find("{")
    while position >= 0 and openings < _MAX_OPENINGS:
        openings += 1
        found = _balanced_object_at(stripped, position)
        if found is not None and _parses_as_object(found):
            return found
        position = stripped.find("{", position + 1)
    return None


def extract_json_object(text: str | None) -> dict[str, Any] | None:
    """The first JSON object in a reply, decoded, or ``None`` when it has none."""
    found = first_json_object_text(text)
    if found is None:
        return None
    value = json.loads(found)
    return value if isinstance(value, dict) else None


def _parses_as_object(candidate: str) -> bool:
    if not candidate.startswith("{"):
        return False
    try:
        return isinstance(json.loads(candidate), dict)
    except ValueError:
        return False
