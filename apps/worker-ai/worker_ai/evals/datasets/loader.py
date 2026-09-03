"""Load a :class:`~worker_ai.evals.datasets.types.Dataset` from a manifest directory.

A dataset directory holds one ``manifest.yaml``:

```yaml
name: hinglish-mini-synth
kind: transcript              # transcript | transliteration | autocut | diarisation | llm
language: hi-en
script: Latin+Devanagari
licence: generated-internal    # mandatory (`Dataset.licence`)
codeMix: true
items:
  - id: hg-001
    language: hi-en            # optional per-item override
    reference:
      reference: "toh chaliye shuru karte hain"
      hints: ["Aksharo"]
```

Three roots are searched, in order, so a licensed set (A00-05) drops in with no
code change once it exists:

1. **Bundled generated sets** — ``evals/datasets/generated/`` — synthetic text
   with known ground truth, committed to this repo.
2. **Bundled fixture adapters** — ``evals/datasets/fixtures/`` — datasets that
   wrap already-recorded fixtures from other WPs (A09's vendor replay corpus,
   B18's ground-truth cut lists); see ``fixtures/*/manifest.yaml`` in this
   directory for what each one wraps and why.
3. **The licensed root** — ``EVAL_LICENSED_DATASETS_DIR``, if set — for A00-05's
   sets. Never bundled, never downloaded by this codebase; an operator points
   this env var at wherever the licensed corpus was purchased and unpacked.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from worker_ai.evals.datasets.types import Dataset, DatasetItem, DatasetSource
from worker_ai.evals.manifest import load_eval_set

__all__ = [
    "FIXTURES_DIR",
    "GENERATED_DIR",
    "DatasetLoadError",
    "available_datasets",
    "licensed_datasets_root",
    "load_dataset",
]

GENERATED_DIR = Path(__file__).with_name("generated")
FIXTURES_DIR = Path(__file__).with_name("fixtures")

#: The three (kind, root, source) combinations searched, in priority order —
#: a licensed set with the same name as a bundled one wins, since a real
#: dataset should always be preferred to its synthetic stand-in.
_LICENSED_ENV_VAR = "EVAL_LICENSED_DATASETS_DIR"


class DatasetLoadError(RuntimeError):
    """A dataset manifest is missing or malformed."""


def licensed_datasets_root() -> Path | None:
    """``EVAL_LICENSED_DATASETS_DIR``, if set and it exists; else ``None``.

    A00-05 has not reported at the time this WP is built, so this is normally
    unset in every environment including CI — the harness runs on synthetic and
    fixture datasets only, per this WP's brief.
    """
    raw = os.environ.get(_LICENSED_ENV_VAR)
    if not raw or not raw.strip():
        return None
    path = Path(raw.strip())
    return path if path.is_dir() else None


def _roots() -> list[tuple[Path, DatasetSource]]:
    roots: list[tuple[Path, DatasetSource]] = [
        (GENERATED_DIR, "generated"),
        (FIXTURES_DIR, "fixture"),
    ]
    licensed = licensed_datasets_root()
    if licensed is not None:
        roots.append((licensed, "licensed"))
    return roots


def available_datasets() -> tuple[str, ...]:
    """Every dataset name discoverable across all three roots, sorted and de-duplicated."""
    names: set[str] = set()
    for root, _source in _roots():
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if (entry / "manifest.yaml").is_file():
                names.add(entry.name)
    return tuple(sorted(names))


def load_dataset(name: str) -> Dataset:
    """Load ``name``, preferring a licensed set over the bundled synthetic one.

    :raises DatasetLoadError: when no root has a directory named ``name`` with a
        manifest, or the manifest does not match the schema.
    """
    for root, source in reversed(_roots()):
        # Reversed so a licensed root (appended last) is tried first.
        directory = root / name
        manifest_path = directory / "manifest.yaml"
        if manifest_path.is_file():
            return _load(directory, manifest_path, source)
    raise DatasetLoadError(
        f"no dataset {name!r}; available: {', '.join(available_datasets()) or 'none'}"
    )


def _load(directory: Path, manifest_path: Path, source: DatasetSource) -> Dataset:
    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise DatasetLoadError(f"could not read {manifest_path}: {error}") from error
    except yaml.YAMLError as error:
        raise DatasetLoadError(f"{manifest_path} is not valid YAML: {error}") from error

    if not isinstance(raw, dict):
        raise DatasetLoadError(f"{manifest_path} must hold a mapping")

    licence = raw.get("licence")
    if not isinstance(licence, str) or not licence.strip():
        raise DatasetLoadError(f"{manifest_path}: `licence` is mandatory (Dataset.licence)")

    kind = raw.get("kind")
    if kind not in ("transcript", "transliteration", "autocut", "diarisation", "llm"):
        raise DatasetLoadError(f"{manifest_path}: unknown or missing kind {kind!r}")

    adapts = raw.get("adaptsEvalSet")
    if adapts is not None:
        if kind != "transcript":
            raise DatasetLoadError(
                f"{manifest_path}: `adaptsEvalSet` only makes sense for kind: transcript"
            )
        items = _items_from_eval_set(str(adapts))
    else:
        items_raw = raw.get("items")
        if not isinstance(items_raw, list) or not items_raw:
            raise DatasetLoadError(f"{manifest_path} lists no items")
        items = tuple(_item(entry, manifest_path) for entry in items_raw)

    ids = [item.id for item in items]
    if len(set(ids)) != len(ids):
        raise DatasetLoadError(f"{manifest_path} has duplicate item ids")

    return Dataset(
        name=str(raw.get("name") or directory.name),
        kind=kind,
        language=str(raw.get("language") or "und"),
        script=str(raw.get("script") or "unknown"),
        licence=licence.strip(),
        items=items,
        source=source,
        directory=directory,
        code_mix=bool(raw.get("codeMix", False)),
        description=str(raw.get("description") or ""),
    )


def _items_from_eval_set(name: str) -> tuple[DatasetItem, ...]:
    """Reinterpret an A09 :class:`~worker_ai.evals.manifest.EvalSet`'s items as
    transcript :class:`DatasetItem`\\ s, so a fixture set already committed for
    A09 counts toward this loader's coverage without a second copy of its
    audio/words files.
    """
    eval_set = load_eval_set(name)
    items: list[DatasetItem] = []
    for item in eval_set.items:
        reference: dict[str, object] = {"reference": item.reference, "hints": list(item.hints)}
        if item.audio is not None:
            reference["audio"] = str(item.audio)
        if item.words is not None:
            reference["words"] = str(item.words)
        items.append(
            DatasetItem(
                id=item.id,
                reference=reference,
                language=item.language or eval_set.language,
            )
        )
    return tuple(items)


def _item(entry: object, manifest_path: Path) -> DatasetItem:
    if not isinstance(entry, dict) or not entry.get("id"):
        raise DatasetLoadError(f"{manifest_path}: every item needs an id")
    reference = entry.get("reference")
    if not isinstance(reference, dict):
        raise DatasetLoadError(f"{manifest_path}: item {entry['id']!r} has no reference payload")
    return DatasetItem(
        id=str(entry["id"]),
        reference=reference,
        language=str(entry["language"]) if entry.get("language") else None,
    )
