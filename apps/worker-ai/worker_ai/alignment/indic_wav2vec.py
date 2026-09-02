"""AI4Bharat IndicWav2Vec CTC alignment — rung 2 of the `09 §2` chain.

The rung that matters most for the product: MIT-licensed CTC heads for roughly
eleven Indic languages (RR-02 F4), which is the cheapest way to reach the ≤ 80 ms
Indic onset target behind Sarvam — a provider that returns no word timings at all
and is therefore always paired with an aligner (D12).

**Roman-script Hinglish aligns on a Devanagari projection, not on the Roman
string** (`09 §2`). The checkpoints were trained on Devanagari characters, so
"matlab" has to become "मतलब" before it can be tokenised; :meth:`prepare_text`
does that with the transliteration table in
:mod:`worker_ai.alignment.romanisation`. IndicXlit would do it better and is A22's
dependency, not this work package's — the table here is deliberately a rule set
with no model behind it, and the aligner degrades to the next rung rather than
guessing when a language has no table.

The checkpoints are not committed and are never downloaded at run time; point
``WORKER_AI_ALIGN_MODEL_DIR`` at a directory laid out as described in
:mod:`worker_ai.alignment.ctc`, with this aligner reading its ``indicwav2vec``
sub-directory.
"""

from __future__ import annotations

from worker_ai.alignment.ctc import CtcAligner
from worker_ai.alignment.romanisation import to_devanagari

__all__ = ["IndicWav2VecAligner"]


class IndicWav2VecAligner(CtcAligner):
    """AI4Bharat CTC heads, loaded lazily per language from the model directory."""

    name = "indicwav2vec-ctc"
    rank = 20
    #: The ten languages the brief names, plus Urdu, which shares the Sarvam lane.
    languages = ("hi", "bn", "gu", "mr", "ne", "or", "ta", "te", "kn", "ml", "ur")

    family = "indicwav2vec"
    #: AI4Bharat, MIT-licensed checkpoints.
    model = "ai4bharat/indicwav2vec"
    licence = "MIT"

    def prepare_text(self, words: tuple[str, ...], language: str) -> tuple[str, ...]:
        """Project Roman-script Hindi onto Devanagari before tokenising (`09 §2`)."""
        return tuple(to_devanagari(word, language) for word in words)
