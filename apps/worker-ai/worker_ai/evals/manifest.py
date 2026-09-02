"""The eval-set manifest format (`09 §8`).

An eval set is a directory under ``fixtures/`` holding one ``manifest.yaml``:

```yaml
set: hinglish-mini
language: hi-en
codeMix: true
audioAvailable: false        # the real audio arrives with A00-05
items:
  - id: hm-001
    audio: audio/hm-001.wav  # relative to the set directory
    reference: "toh aaj hum baat karenge"
    hints: ["Aksharo"]
    words: words/hm-001.json # optional: what the mock provider should return
```

Two rules keep the format honest:

* **The reference is the ground truth**, written by a human. Nothing in the
  pipeline may generate it, or the WER measures the pipeline against itself.
* **Audio is optional until it exists.** `09 §8` puts the real sets in A00-05, so a
  set may ship with references and no media; a provider that reads audio then
  refuses to run against it, and the mock (which does not) still exercises the
  harness end to end.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

__all__ = [
    "FIXTURES_DIR",
    "EvalItem",
    "EvalManifestError",
    "EvalSet",
    "available_sets",
    "load_eval_set",
]

#: Eval sets ship inside the package so a container has them without a mount.
FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


class EvalManifestError(RuntimeError):
    """A manifest is missing or malformed."""


@dataclass(frozen=True, slots=True)
class EvalItem:
    """One clip of an eval set."""

    id: str
    reference: str
    audio: Path | None = None
    hints: tuple[str, ...] = ()
    #: Words the mock provider should return for this item, if any.
    words: Path | None = None
    language: str | None = None


@dataclass(frozen=True, slots=True)
class EvalSet:
    """A whole set: metadata plus its items."""

    name: str
    language: str
    directory: Path
    items: tuple[EvalItem, ...]
    code_mix: bool = False
    audio_available: bool = False
    description: str = ""


def available_sets(root: Path | None = None) -> tuple[str, ...]:
    """Every set directory that holds a manifest, sorted."""
    base = root or FIXTURES_DIR
    if not base.is_dir():
        return ()
    return tuple(
        sorted(entry.name for entry in base.iterdir() if (entry / "manifest.yaml").is_file())
    )


def load_eval_set(reference: str | Path, root: Path | None = None) -> EvalSet:
    """Load a set by name (``hinglish-mini``) or by path (``fixtures/hinglish-mini``)."""
    directory = _resolve(reference, root)
    manifest_path = directory / "manifest.yaml"
    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise EvalManifestError(f"could not read {manifest_path}: {error}") from error
    except yaml.YAMLError as error:
        raise EvalManifestError(f"{manifest_path} is not valid YAML: {error}") from error

    if not isinstance(raw, dict):
        raise EvalManifestError(f"{manifest_path} must hold a mapping")
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw:
        raise EvalManifestError(f"{manifest_path} lists no items")

    items = tuple(_item(entry, directory, manifest_path) for entry in items_raw)
    ids = [item.id for item in items]
    if len(set(ids)) != len(ids):
        raise EvalManifestError(f"{manifest_path} has duplicate item ids")

    return EvalSet(
        name=str(raw.get("set") or directory.name),
        language=str(raw.get("language") or "und"),
        directory=directory,
        items=items,
        code_mix=bool(raw.get("codeMix", False)),
        audio_available=bool(raw.get("audioAvailable", False)),
        description=str(raw.get("description") or ""),
    )


def _resolve(reference: str | Path, root: Path | None) -> Path:
    candidate = Path(reference)
    if candidate.is_dir():
        return candidate
    base = root or FIXTURES_DIR
    named = base / candidate.name
    if named.is_dir():
        return named
    raise EvalManifestError(
        f"no eval set at {reference!r}; available: {', '.join(available_sets(base)) or 'none'}"
    )


def _item(entry: object, directory: Path, manifest_path: Path) -> EvalItem:
    if not isinstance(entry, dict) or not entry.get("id"):
        raise EvalManifestError(f"{manifest_path}: every item needs an id")
    reference = entry.get("reference")
    if not isinstance(reference, str) or not reference.strip():
        raise EvalManifestError(
            f"{manifest_path}: item {entry['id']!r} has no reference transcript"
        )
    hints_raw = entry.get("hints") or []
    if not isinstance(hints_raw, list):
        raise EvalManifestError(f"{manifest_path}: item {entry['id']!r} has malformed hints")
    return EvalItem(
        id=str(entry["id"]),
        reference=reference.strip(),
        audio=directory / str(entry["audio"]) if entry.get("audio") else None,
        hints=tuple(str(hint) for hint in hints_raw),
        words=directory / str(entry["words"]) if entry.get("words") else None,
        language=str(entry["language"]) if entry.get("language") else None,
    )
