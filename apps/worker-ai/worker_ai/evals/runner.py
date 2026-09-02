"""Run an eval set through a provider and report WER/CER (`09 §8`).

The regression harness this grows into runs nightly and on every provider or model
change, and blocks a routing change on a WER regression greater than one point.
A09 ships the mechanism and one synthetic set; the real sets arrive with A00-05,
at which point the only thing that changes here is which directory is passed in.

Aggregate WER is computed over the **concatenated** corpus rather than as a mean
of per-item rates, because a mean over items weights a three-word clip the same as
a three-minute one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from worker_ai.evals.manifest import EvalItem, EvalSet
from worker_ai.evals.metrics import TranscriptScore, cer, score, wer
from worker_ai.providers.base import Provider, ProviderError, TranscriptionRequest

__all__ = ["EvalReport", "run_eval_set", "transcribe_item"]


@dataclass(frozen=True, slots=True)
class EvalReport:
    """The result of one run over one set."""

    set_name: str
    provider: str
    language: str
    scores: tuple[TranscriptScore, ...]
    corpus_wer: float
    corpus_cer: float
    skipped: tuple[tuple[str, str], ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "set": self.set_name,
            "provider": self.provider,
            "language": self.language,
            "corpusWer": round(self.corpus_wer, 4),
            "corpusCer": round(self.corpus_cer, 4),
            "items": [item.to_wire() for item in self.scores],
            "skipped": [{"itemId": item, "reason": reason} for item, reason in self.skipped],
        }

    def table(self) -> str:
        """A fixed-width table, which is what the CLI prints."""
        lines = [
            f"eval set {self.set_name} · provider {self.provider} · {self.language}",
            f"{'item':<16}{'WER':>8}{'CER':>8}{'ref':>6}{'hyp':>6}",
            "-" * 44,
        ]
        for item in self.scores:
            lines.append(
                f"{item.item_id:<16}{item.wer:>8.3f}{item.cer:>8.3f}"
                f"{item.reference_words:>6}{item.hypothesis_words:>6}"
            )
        lines.append("-" * 44)
        lines.append(f"{'corpus':<16}{self.corpus_wer:>8.3f}{self.corpus_cer:>8.3f}")
        for item_id, reason in self.skipped:
            lines.append(f"skipped {item_id}: {reason}")
        return "\n".join(lines)


async def transcribe_item(
    provider: Provider, item: EvalItem, language: str
) -> tuple[str, list[int]]:
    """Transcribe one item, returning its text and its word onsets."""
    options: dict[str, object] = {}
    if item.words is not None:
        options["wordFixture"] = str(item.words)
    result = await provider.transcribe(
        TranscriptionRequest(
            audio_uri=str(item.audio) if item.audio is not None else f"eval://{item.id}",
            language=item.language or language,
            hints=item.hints,
            options=options,
        )
    )
    if result.words:
        return " ".join(word.t for word in result.words), [word.s for word in result.words]
    # A provider with no word timings — Sarvam — returns chunk-level segments and
    # the aligner is a separate stage (D13). WER is a property of the *text*, so
    # it is measured here on the text the provider actually returned; onset error
    # is the aligner's metric and is measured against `ai.align`, not here.
    return " ".join(segment[2] for segment in result.segments), [
        segment[0] for segment in result.segments
    ]


async def run_eval_set(eval_set: EvalSet, provider: Provider) -> EvalReport:
    """Score every item of ``eval_set`` with ``provider``."""
    scores: list[TranscriptScore] = []
    skipped: list[tuple[str, str]] = []
    references: list[str] = []
    hypotheses: list[str] = []

    for item in eval_set.items:
        if provider.reads_audio and (item.audio is None or not item.audio.is_file()):
            skipped.append((item.id, "the set has no audio yet (`09 §8`: A00-05 ships it)"))
            continue
        try:
            hypothesis, _onsets = await transcribe_item(provider, item, eval_set.language)
        except ProviderError as error:
            skipped.append((item.id, str(error)))
            continue
        scores.append(score(item.id, item.reference, hypothesis))
        references.append(item.reference)
        hypotheses.append(hypothesis)

    corpus_reference = " ".join(references)
    corpus_hypothesis = " ".join(hypotheses)
    return EvalReport(
        set_name=eval_set.name,
        provider=provider.name,
        language=eval_set.language,
        scores=tuple(scores),
        corpus_wer=wer(corpus_reference, corpus_hypothesis) if references else 0.0,
        corpus_cer=cer(corpus_reference, corpus_hypothesis) if references else 0.0,
        skipped=tuple(skipped),
    )
