"""Length-aware translation (`09 §4`): target text stays close to source length.

A caption has a fixed box on screen; a translation twice as long as the source
either overflows it or gets clipped, both worse than a slightly loose
translation. The rule: **target ≤ 1.3x source, in characters**. A segment over
the limit gets one retry asking the provider for something shorter
(`TranslationSegment.shorter`); a segment still over the limit after every retry
is **hard-truncated** on a word boundary so the invariant holds structurally,
never just probabilistically — a caption that is a little short of the "ideal"
translation is always better than one that silently breaks its own budget.
"""

from __future__ import annotations

__all__ = ["MAX_LENGTH_RATIO", "exceeds_budget", "truncate_to_budget"]

MAX_LENGTH_RATIO = 1.3


def exceeds_budget(source: str, translated: str) -> bool:
    """True when `translated` is more than 1.3x `source`'s character count.

    An empty source has no budget to exceed — a translation appearing where
    there was nothing is a different bug, not a length one.
    """
    if source.strip() == "":
        return False
    return len(translated) > len(source) * MAX_LENGTH_RATIO


def truncate_to_budget(source: str, translated: str) -> str:
    """Cut `translated` to fit the 1.3x budget, on the last whole word inside it.

    Ellipsis is appended so a truncated caption reads as cut off rather than as
    a complete (wrong) sentence — one character of the budget is reserved for
    it, so the result is never itself over budget.
    """
    limit = max(1, int(len(source) * MAX_LENGTH_RATIO))
    if len(translated) <= limit:
        return translated
    budget = max(1, limit - 1)
    window = translated[:budget]
    boundary = window.rfind(" ")
    cut = window[:boundary] if boundary > 0 else window
    return f"{cut.rstrip()}…"
