"""D08's dataset loader interface (`Dataset(name, language, script, items[])`).

See :mod:`worker_ai.evals.datasets.loader` for the loader and
:mod:`worker_ai.evals.datasets.types` for the shapes.
"""

from __future__ import annotations

from worker_ai.evals.datasets.loader import (
    FIXTURES_DIR,
    GENERATED_DIR,
    DatasetLoadError,
    available_datasets,
    licensed_datasets_root,
    load_dataset,
)
from worker_ai.evals.datasets.types import Dataset, DatasetItem, DatasetKind, DatasetSource

__all__ = [
    "FIXTURES_DIR",
    "GENERATED_DIR",
    "Dataset",
    "DatasetItem",
    "DatasetKind",
    "DatasetLoadError",
    "DatasetSource",
    "available_datasets",
    "licensed_datasets_root",
    "load_dataset",
]
