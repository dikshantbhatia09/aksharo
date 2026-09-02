"""Meta MMS multilingual CTC alignment — rung 3 of the `09 §2` chain.

The breadth option. MMS covers far more languages than IndicWav2Vec, at lower
accuracy, and it needs a **romanisation step** for non-Latin scripts — which is
exactly why it sits *below* the Indic heads and *above* the proportional
fallback. It is one CTC head for every language rather than one per language, so
the model directory holds a single ``multilingual`` checkpoint.

**Licence, unresolved.** The widely distributed
``facebook/mms-300m-1130-forced-aligner`` export is CC-BY-NC-4.0, which is
non-commercial and therefore unusable here; the underlying MMS release is
CC-BY-NC-4.0 as well, while ``mms-1b-all`` is Apache-2.0 through fairseq2 under
some redistributions. A09 flagged this and A10 cannot resolve it without counsel,
so the licence string below says so and the aligner is **inert until a model
directory is configured** — no weight is downloaded, and a deployment that has
not made the licence decision simply never reaches this rung. Recorded as an open
question for the orchestrator.
"""

from __future__ import annotations

from pathlib import Path

from worker_ai.alignment.ctc import CtcAligner
from worker_ai.alignment.romanisation import romanise

__all__ = ["MmsAligner"]


class MmsAligner(CtcAligner):
    """One multilingual CTC head, fed romanised text."""

    name = "mms-ctc"
    rank = 30
    languages = ()  # multilingual by design

    family = "mms"
    model = "facebook/mms-300m-1130-forced-aligner"
    licence = "CC-BY-NC-4.0 on the common export — commercial variant unresolved (A10)"

    def language_dir(self, language: str) -> Path | None:
        """One checkpoint for every language, unlike the per-language Indic heads."""
        del language
        if not self.model_dir:
            return None
        return Path(self.model_dir) / self.family / "multilingual"

    def prepare_text(self, words: tuple[str, ...], language: str) -> tuple[str, ...]:
        """Romanise before tokenising: the MMS vocabulary is Latin (`09 §2`)."""
        del language
        return tuple(romanise(word) for word in words)
