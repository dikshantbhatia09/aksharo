"""Score a :class:`~worker_ai.evals.datasets.types.Dataset` of any kind.

A09's :func:`~worker_ai.evals.runner.run_eval_set` stays the transcript-only
runner (it needs a live/mock/replayed :class:`~worker_ai.providers.base.Provider`).
This module is the dispatcher D08 adds on top of it: it recognises the other
four kinds a :class:`Dataset` can carry and scores each with the metric that
matches (`09 §8`; `apps/worker-ai/worker_ai/evals/metrics.py`), and it also
covers ``transcript`` datasets by building the same :class:`EvalSet` A09's
runner already knows how to score.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from worker_ai.evals.datasets.types import Dataset
from worker_ai.evals.manifest import EvalItem, EvalSet
from worker_ai.evals.metrics import (
    DiarisationSegment,
    autocut_precision_recall,
    cer,
    diarisation_der,
    llm_pass_rate,
    transliteration_accuracy,
    wer,
)
from worker_ai.evals.runner import EvalReport, run_eval_set
from worker_ai.providers.base import Provider
from worker_ai.transliterate.tables import romanise_word, transliterate_word

__all__ = ["DatasetReport", "cer", "run_dataset", "wer"]


@dataclass(frozen=True, slots=True)
class DatasetReport:
    """One dataset's scored run, whatever its kind."""

    dataset_name: str
    kind: str
    language: str
    licence: str
    metrics: dict[str, float]
    items: tuple[dict[str, Any], ...]
    skipped: tuple[tuple[str, str], ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "dataset": self.dataset_name,
            "kind": self.kind,
            "language": self.language,
            "licence": self.licence,
            "metrics": {name: round(value, 4) for name, value in self.metrics.items()},
            "items": list(self.items),
            "skipped": [{"itemId": item, "reason": reason} for item, reason in self.skipped],
        }


async def run_dataset(dataset: Dataset, *, provider: Provider | None = None) -> DatasetReport:
    """Score every item of ``dataset`` with the metric its ``kind`` calls for.

    :param provider: required (and used) only for ``kind: transcript``; ignored
        otherwise. Raises :class:`ValueError` when a transcript dataset is run
        with no provider, since there is nothing to score it with.
    """
    if dataset.kind == "transcript":
        if provider is None:
            raise ValueError(f"dataset {dataset.name!r} is kind: transcript and needs a provider")
        return await _run_transcript(dataset, provider)
    if dataset.kind == "transliteration":
        return _run_transliteration(dataset)
    if dataset.kind == "autocut":
        return _run_autocut(dataset)
    if dataset.kind == "diarisation":
        return _run_diarisation(dataset)
    if dataset.kind == "llm":
        return _run_llm(dataset)
    raise ValueError(f"dataset {dataset.name!r} has an unhandled kind {dataset.kind!r}")


async def _run_transcript(dataset: Dataset, provider: Provider) -> DatasetReport:
    eval_set = _to_eval_set(dataset)
    report: EvalReport = await run_eval_set(eval_set, provider)
    metrics = {"corpusWer": report.corpus_wer, "corpusCer": report.corpus_cer}
    items = tuple(item.to_wire() for item in report.scores)
    return DatasetReport(
        dataset_name=dataset.name,
        kind=dataset.kind,
        language=dataset.language,
        licence=dataset.licence,
        metrics=metrics,
        items=items,
        skipped=report.skipped,
    )


def _to_eval_set(dataset: Dataset) -> EvalSet:
    directory = dataset.directory or Path(".")
    items = []
    for item in dataset.items:
        reference = str(item.reference.get("reference") or "")
        hints = tuple(str(hint) for hint in item.reference.get("hints") or [])
        audio = item.reference.get("audio")
        words = item.reference.get("words")
        items.append(
            EvalItem(
                id=item.id,
                reference=reference,
                audio=Path(audio) if isinstance(audio, str) else None,
                hints=hints,
                words=Path(words) if isinstance(words, str) else None,
                language=item.language,
            )
        )
    return EvalSet(
        name=dataset.name,
        language=dataset.language,
        directory=directory,
        items=tuple(items),
        code_mix=dataset.code_mix,
        audio_available=any(item.audio is not None for item in items),
        description=dataset.description,
    )


def _run_transliteration(dataset: Dataset) -> DatasetReport:
    scores: list[float] = []
    items: list[dict[str, Any]] = []
    skipped: list[tuple[str, str]] = []
    for item in dataset.items:
        token = item.reference.get("token")
        direction = item.reference.get("direction")
        expected = item.reference.get("expected")
        language = item.language or dataset.language
        if not isinstance(token, str) or not isinstance(expected, str):
            skipped.append((item.id, "missing token/expected"))
            continue
        if direction == "to_native":
            hypothesis = transliterate_word(token, language=language)
        elif direction == "to_roman":
            hypothesis = romanise_word(token, language=language)
        else:
            skipped.append((item.id, f"unknown direction {direction!r}"))
            continue
        accuracy = transliteration_accuracy(expected, hypothesis)
        scores.append(accuracy)
        items.append(
            {
                "itemId": item.id,
                "token": token,
                "expected": expected,
                "hypothesis": hypothesis,
                "accuracy": accuracy,
            }
        )
    accuracy_mean = sum(scores) / len(scores) if scores else 0.0
    return DatasetReport(
        dataset_name=dataset.name,
        kind=dataset.kind,
        language=dataset.language,
        licence=dataset.licence,
        metrics={"transliterationAccuracy": accuracy_mean},
        items=tuple(items),
        skipped=tuple(skipped),
    )


def _run_autocut(dataset: Dataset) -> DatasetReport:
    items: list[dict[str, Any]] = []
    skipped: list[tuple[str, str]] = []
    precisions: list[float] = []
    recalls: list[float] = []
    f1s: list[float] = []
    for item in dataset.items:
        reference_raw = item.reference.get("referenceCuts")
        candidate_raw = item.reference.get("candidateCuts")
        if not isinstance(reference_raw, list) or not isinstance(candidate_raw, list):
            skipped.append((item.id, "missing referenceCuts/candidateCuts"))
            continue
        reference_cuts = [(int(pair[0]), int(pair[1])) for pair in reference_raw]
        candidate_cuts = [(int(pair[0]), int(pair[1])) for pair in candidate_raw]
        result = autocut_precision_recall(reference_cuts, candidate_cuts)
        precisions.append(result.precision)
        recalls.append(result.recall)
        f1s.append(result.f1)
        items.append({"itemId": item.id, **result.to_wire()})
    count = len(precisions) or 1
    return DatasetReport(
        dataset_name=dataset.name,
        kind=dataset.kind,
        language=dataset.language,
        licence=dataset.licence,
        metrics={
            "autocutPrecision": sum(precisions) / count,
            "autocutRecall": sum(recalls) / count,
            "autocutF1": sum(f1s) / count,
        },
        items=tuple(items),
        skipped=tuple(skipped),
    )


def _run_diarisation(dataset: Dataset) -> DatasetReport:
    items: list[dict[str, Any]] = []
    skipped: list[tuple[str, str]] = []
    ders: list[float] = []
    for item in dataset.items:
        reference_raw = item.reference.get("reference")
        hypothesis_raw = item.reference.get("hypothesis")
        if not isinstance(reference_raw, list) or not isinstance(hypothesis_raw, list):
            skipped.append((item.id, "missing reference/hypothesis segments"))
            continue
        reference = [
            DiarisationSegment(str(row[0]), int(row[1]), int(row[2])) for row in reference_raw
        ]
        hypothesis = [
            DiarisationSegment(str(row[0]), int(row[1]), int(row[2])) for row in hypothesis_raw
        ]
        der = diarisation_der(reference, hypothesis)
        ders.append(der)
        items.append({"itemId": item.id, "der": round(der, 4)})
    count = len(ders) or 1
    return DatasetReport(
        dataset_name=dataset.name,
        kind=dataset.kind,
        language=dataset.language,
        licence=dataset.licence,
        metrics={"der": sum(ders) / count},
        items=tuple(items),
        skipped=tuple(skipped),
    )


def _run_llm(dataset: Dataset) -> DatasetReport:
    items: list[dict[str, Any]] = []
    skipped: list[tuple[str, str]] = []
    pooled_checks: list[bool] = []
    for item in dataset.items:
        checks = item.reference.get("checks")
        if not isinstance(checks, list):
            skipped.append((item.id, "missing checks"))
            continue
        bool_checks = [bool(check) for check in checks]
        pooled_checks.extend(bool_checks)
        items.append({"itemId": item.id, "passRate": round(llm_pass_rate(bool_checks), 4)})
    return DatasetReport(
        dataset_name=dataset.name,
        kind=dataset.kind,
        language=dataset.language,
        licence=dataset.licence,
        metrics={"llmPassRate": llm_pass_rate(pooled_checks)},
        items=tuple(items),
        skipped=tuple(skipped),
    )

