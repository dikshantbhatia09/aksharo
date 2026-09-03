"""The dataset loader interface D08's brief asks for: ``Dataset(name, language,
script, items[])`` with a mandatory ``licence`` field.

This sits beside, not instead of, A09's :mod:`worker_ai.evals.manifest`
(``EvalSet``/``EvalItem``), which stays the shape a *transcript* eval set uses to
talk to a :class:`~worker_ai.providers.base.Provider`. ``Dataset`` is the wider
umbrella covering every metric this WP adds — transliteration accuracy, autocut
precision/recall, diarisation DER, an LLM check pass rate — each of which scores
a fixed reference against a fixture-defined (or, for transcript sets, a
provider-produced) hypothesis rather than calling a transcription vendor.

**The licence field is mandatory and is not decoration.** `A00-05` (licensed
Indic eval datasets, human item) has not reported at the time this WP is built,
so every dataset that ships here is synthetic or already-committed fixture data
— see :data:`DatasetSource`. The day A00-05 lands, the licensed sets are loaded
by pointing :func:`~worker_ai.evals.datasets.loader.load_dataset` at a directory
named by ``EVAL_LICENSED_DATASETS_DIR`` (never committed, never downloaded by
this codebase); the manifest format and the ``licence`` field are exactly the
same, so no loader code changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

__all__ = [
    "Dataset",
    "DatasetItem",
    "DatasetKind",
    "DatasetSource",
]

#: What a dataset measures, and therefore how its items are scored.
DatasetKind = Literal["transcript", "transliteration", "autocut", "diarisation", "llm"]

#: Where the bytes came from. ``generated`` = produced by a script in this repo
#: from no external input (synthetic Hinglish/Hindi/Tamil text with known ground
#: truth); ``fixture`` = already-recorded fixtures from another WP (A09 vendor
#: replay sessions, A22 transliteration tables, B18 autocut); ``licensed`` = an
#: A00-05 set loaded from an external path, never committed to this repository.
DatasetSource = Literal["generated", "fixture", "licensed"]


@dataclass(frozen=True, slots=True)
class DatasetItem:
    """One scoring unit. The reference (ground truth) payload is kind-shaped:

    * ``transcript``: ``{"reference": str, "hints": [str], "audio": path|None}``
    * ``transliteration``: ``{"token": str, "direction": "to_native"|"to_roman",
      "expected": str}``
    * ``autocut``: ``{"referenceCuts": [[startMs, endMs], ...],
      "candidateCuts": [[startMs, endMs], ...]}``
    * ``diarisation``: ``{"reference": [[speaker, startMs, endMs], ...],
      "hypothesis": [[speaker, startMs, endMs], ...]}``
    * ``llm``: ``{"checks": [bool, ...]}``
    """

    id: str
    reference: dict[str, Any]
    language: str | None = None


@dataclass(frozen=True, slots=True)
class Dataset:
    """A named, licensed collection of items measuring one :data:`DatasetKind`."""

    name: str
    kind: DatasetKind
    language: str
    script: str
    licence: str
    items: tuple[DatasetItem, ...]
    source: DatasetSource = "generated"
    directory: Path | None = None
    code_mix: bool = False
    description: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "language": self.language,
            "script": self.script,
            "licence": self.licence,
            "source": self.source,
            "codeMix": self.code_mix,
            "itemCount": len(self.items),
        }
