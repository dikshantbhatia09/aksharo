"""Metrics bridge for C03b's local-engine quality gate (`apps/engine/bench/**`).

The Node harness (`apps/engine/bench/run.ts`) drives `apps/engine`'s HTTP
contract via `@montaj/engine-client` and gets word timings back; scoring those
against the committed cloud-aligner reference (`apps/engine/fixtures/
hinglish-reference.json`) reuses this package's own WER/CER/onset-error
metrics (`worker_ai.evals.metrics`, built for D08's regression harness)
instead of a second, driftable implementation in TypeScript — the brief's
"Node + a thin Python metrics call".

Invoked as a CLI: a single JSON object on stdin, a single JSON object on
stdout, one call per fixture item, no server process. This keeps the calling
Node process simple (a synchronous `spawnSync`, no long-lived Python process
to manage) and keeps this module trivially testable without any subprocess at
all (`score_item` below is what the tests call directly).

stdin shape::

    {
      "referenceText": "toh aaj hum shuru karte hain",
      "hypothesisText": "toh aaj hum shuru karte hain",
      "referenceWordsMs": [10, 345, 615, 880, 1430, 1790],
      "hypothesisWordsMs": [12, 350, 610, 895, 1425, 1795]
    }

``referenceWordsMs``/``hypothesisWordsMs`` are word *onset* times in
milliseconds; omit either (or leave the lengths mismatched) to skip the
onset-error figure — see :func:`worker_ai.evals.metrics.median_onset_error_ms`.

stdout shape::

    {"wer": 0.0, "cer": 0.0, "onsetErrorMedianMs": 5.0}
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any

from worker_ai.evals.metrics import cer, median_onset_error_ms, wer

__all__ = ["LocalEngineScore", "main", "score_item"]


@dataclass(frozen=True, slots=True)
class LocalEngineScore:
    """One fixture item's local-engine-vs-cloud-aligner score."""

    wer: float
    cer: float
    onset_error_median_ms: float | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "wer": round(self.wer, 4),
            "cer": round(self.cer, 4),
            "onsetErrorMedianMs": self.onset_error_median_ms,
        }


def score_item(
    reference_text: str,
    hypothesis_text: str,
    reference_words_ms: list[int] | None = None,
    hypothesis_words_ms: list[int] | None = None,
) -> LocalEngineScore:
    """WER/CER of the pair, plus median onset error (both onset lists given, equal length)."""
    onset = None
    if reference_words_ms is not None and hypothesis_words_ms is not None:
        onset = median_onset_error_ms(reference_words_ms, hypothesis_words_ms)
    return LocalEngineScore(
        wer=wer(reference_text, hypothesis_text),
        cer=cer(reference_text, hypothesis_text),
        onset_error_median_ms=onset,
    )


def main(argv: list[str] | None = None) -> int:
    """CLI entry: read one JSON request from stdin, write one JSON response to stdout."""
    del argv  # No flags today; the request is entirely in the stdin payload.
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"invalid JSON on stdin: {error}"}), file=sys.stderr)
        return 1

    score = score_item(
        reference_text=payload.get("referenceText", ""),
        hypothesis_text=payload.get("hypothesisText", ""),
        reference_words_ms=payload.get("referenceWordsMs"),
        hypothesis_words_ms=payload.get("hypothesisWordsMs"),
    )
    print(json.dumps(score.to_wire()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
