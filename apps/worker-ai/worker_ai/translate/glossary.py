"""Glossary terms stay verbatim through translation (`09 §4`).

No translation vendor takes a "never touch this word" instruction reliably —
Sarvam and IndicTrans2 have no such parameter at all, and even an LLM prompted
to leave a term alone sometimes "helpfully" translates it anyway. So this module
does not ask; it **removes the term from the text the provider ever sees**.

Before a segment is sent, every glossary term (case-insensitive whole-word
match) is replaced with an opaque placeholder (`⟦G0⟧`, `⟦G1⟧`, ...) that no
translation model has any reason to alter — it looks like a citation marker, not
a word. After translation, every placeholder is replaced back with the original
term. This is provider-agnostic by construction: it wraps whichever adapter the
chain picked, so Sarvam, IndicTrans2 and the LLM path all get the same
guarantee for free.

Placeholders are chosen not to collide with the text: `⟦`/`⟧` (U+27E6/U+27E7,
MATHEMATICAL LEFT/RIGHT WHITE SQUARE BRACKET) essentially never appears in
transcribed speech, and the substitution is skipped entirely for a segment that
already contains one, rather than risk restoring the wrong span.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

__all__ = ["GlossaryMasked", "mask_glossary_terms", "unmask_glossary_terms"]

_PLACEHOLDER_OPEN = "⟦"
_PLACEHOLDER_CLOSE = "⟧"


@dataclass(frozen=True, slots=True)
class GlossaryMasked:
    text: str
    #: `placeholder -> original term`, in the case actually found in the text.
    terms: dict[str, str]


def mask_glossary_terms(text: str, glossary: tuple[str, ...]) -> GlossaryMasked:
    """Replace every glossary term in `text` with a placeholder token.

    Longest terms first, so a term that is a substring of another glossary term
    ("Aksharo" inside "Aksharo Panel") does not get masked out from under the
    longer match. Terms are matched whole-word and case-insensitively; the
    *original* casing found in the text is what comes back after translation, not
    the glossary's own casing.
    """
    if _PLACEHOLDER_OPEN in text or _PLACEHOLDER_CLOSE in text:
        return GlossaryMasked(text=text, terms={})

    ordered = sorted({term for term in glossary if term.strip()}, key=len, reverse=True)
    if not ordered:
        return GlossaryMasked(text=text, terms={})

    terms: dict[str, str] = {}
    masked = text
    for index, term in enumerate(ordered):
        pattern = re.compile(rf"(?<!\w){re.escape(term)}(?!\w)", re.IGNORECASE)
        placeholder = f"{_PLACEHOLDER_OPEN}G{index}{_PLACEHOLDER_CLOSE}"
        masked = pattern.sub(_masker(placeholder, terms), masked)

    return GlossaryMasked(text=masked, terms=terms)


def _masker(placeholder: str, found: dict[str, str]) -> Callable[[re.Match[str]], str]:
    """A substitution function bound to *this* placeholder, not the loop variable."""

    def _replace(match: re.Match[str]) -> str:
        found[placeholder] = match.group(0)
        return placeholder

    return _replace


def unmask_glossary_terms(text: str, terms: dict[str, str]) -> str:
    """Put every masked term back. A placeholder a provider dropped stays dropped."""
    restored = text
    for placeholder, original in terms.items():
        restored = restored.replace(placeholder, original)
    return restored
