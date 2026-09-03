"""SHA-256 manifest of every committed dataset file (`09 §8`, D08 brief §1).

The eval harness's own integrity check: ``manifest.json`` (committed, generated
by :func:`build_manifest`) records a checksum for every file under the
bundled ``generated/`` and ``fixtures/`` roots, so a corrupted or hand-edited
fixture is caught by :func:`verify_manifest` rather than silently changing what
a nightly run measures. The licensed root (`EVAL_LICENSED_DATASETS_DIR`) is
deliberately excluded — it is never committed here, so this repo has no
business asserting what its checksums should be; A00-05's own delivery process
owns integrity for that corpus.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

__all__ = ["MANIFEST_FILENAME", "ChecksumMismatchError", "build_manifest", "verify_manifest"]

MANIFEST_FILENAME = "manifest.json"


class ChecksumMismatchError(RuntimeError):
    """A committed dataset file does not match `manifest.json`."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.name != MANIFEST_FILENAME
    )


def build_manifest(roots: list[Path]) -> dict[str, Any]:
    """Compute ``{relativePath: sha256}`` for every file under every root.

    Paths are recorded relative to each root's *parent* (e.g.
    ``generated/hinglish-mini-synth/manifest.yaml``) so the manifest reads the
    same regardless of where the repository is checked out.
    """
    entries: dict[str, str] = {}
    for root in roots:
        base = root.parent
        for path in _files(root):
            entries[str(path.relative_to(base)).replace("\\", "/")] = _sha256(path)
    return {"algorithm": "sha256", "files": dict(sorted(entries.items()))}


def write_manifest(manifest_path: Path, roots: list[Path]) -> dict[str, Any]:
    """Compute and write the manifest, returning what was written."""
    manifest = build_manifest(roots)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def verify_manifest(manifest_path: Path, roots: list[Path]) -> None:
    """Recompute every checksum and compare against ``manifest_path``.

    :raises ChecksumMismatchError: naming every file that is missing, extra, or whose
        hash no longer matches — the full diagnosis in one exception, not just
        the first mismatch found.
    """
    if not manifest_path.is_file():
        raise ChecksumMismatchError(f"{manifest_path} does not exist; run build_manifest first")
    recorded = json.loads(manifest_path.read_text(encoding="utf-8"))
    recorded_files: dict[str, str] = recorded.get("files", {})
    current = build_manifest(roots)["files"]

    missing = sorted(set(recorded_files) - set(current))
    extra = sorted(set(current) - set(recorded_files))
    changed = sorted(
        path
        for path in set(recorded_files) & set(current)
        if recorded_files[path] != current[path]
    )
    if not missing and not extra and not changed:
        return
    problems = []
    if missing:
        problems.append(f"missing: {', '.join(missing)}")
    if extra:
        problems.append(f"extra (not in manifest): {', '.join(extra)}")
    if changed:
        problems.append(f"changed: {', '.join(changed)}")
    raise ChecksumMismatchError("; ".join(problems))
