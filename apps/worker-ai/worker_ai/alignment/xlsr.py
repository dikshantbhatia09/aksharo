"""XLSR-53 CTC alignment — rung 3 of the `09 §2` chain, for global languages.

Decision **D77** removed Meta MMS from the product: the widely distributed
``facebook/mms-300m-1130-forced-aligner`` export is **CC-BY-NC-4.0**, which is
non-commercial and therefore unusable here, and no Apache-licensed equivalent of
that particular export exists. The breadth rung is now the
``jonatasgrosman/wav2vec2-large-xlsr-53-*`` fine-tunes, which are **Apache-2.0**
and are already what the GPU model server bakes in
(``apps/model-server/scripts/bake_models.py --aligner-global``; that script also
refuses an MMS argument, so D77 cannot be undone with a ``--build-arg``).

The split between rungs 2 and 3 is now by language family rather than by
accuracy:

* **Indic** goes to :class:`~worker_ai.alignment.indic_wav2vec.IndicWav2VecAligner`
  (AI4Bharat, MIT) — eleven languages, Devanagari projection in front of it.
* **Global** goes here — one Apache-2.0 fine-tune per language, each with its own
  vocabulary in that language's own script, so **no romanisation step is needed**
  and none is done. That is the practical difference from MMS, whose single
  multilingual Latin head had to be fed transliterated text.

Anything neither rung covers falls to the proportional + VAD fallback, which is
the rung that must never be missing.

Checkpoints are not committed and are never downloaded at run time; point
``WORKER_AI_ALIGN_MODEL_DIR`` at a directory laid out as described in
:mod:`worker_ai.alignment.ctc`, with this aligner reading its ``xlsr53``
sub-directory.
"""

from __future__ import annotations

from worker_ai.alignment.ctc import CtcAligner

__all__ = ["XLSR53_LANGUAGES", "Xlsr53Aligner"]

#: The languages `jonatasgrosman` publishes an Apache-2.0 XLSR-53 CTC fine-tune
#: for. This tuple is a *coverage claim*; whether a checkpoint is actually
#: installed is answered per language by ``available_for``.
XLSR53_LANGUAGES: tuple[str, ...] = (
    "ar",
    "de",
    "el",
    "en",
    "es",
    "fa",
    "fi",
    "fr",
    "hu",
    "it",
    "ja",
    "nl",
    "pl",
    "pt",
    "ru",
    "zh",
)


class Xlsr53Aligner(CtcAligner):
    """Per-language XLSR-53 CTC heads, loaded lazily from the model directory."""

    name = "xlsr53-ctc"
    rank = 30
    languages = XLSR53_LANGUAGES

    family = "xlsr53"
    model = "jonatasgrosman/wav2vec2-large-xlsr-53-<language>"
    licence = "Apache-2.0"
