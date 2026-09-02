"""Eval harness: fixture manifests, WER/CER metrics and the runner (`09 §8`)."""

from __future__ import annotations

from worker_ai.evals.manifest import (
    FIXTURES_DIR,
    EvalItem,
    EvalManifestError,
    EvalSet,
    available_sets,
    load_eval_set,
)
from worker_ai.evals.metrics import TranscriptScore, cer, median_onset_error_ms, normalise, wer
from worker_ai.evals.runner import EvalReport, run_eval_set

__all__ = [
    "FIXTURES_DIR",
    "EvalItem",
    "EvalManifestError",
    "EvalReport",
    "EvalSet",
    "TranscriptScore",
    "available_sets",
    "cer",
    "load_eval_set",
    "median_onset_error_ms",
    "normalise",
    "run_eval_set",
    "wer",
]
