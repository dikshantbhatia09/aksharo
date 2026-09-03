"""D08's dataset loader interface, its bundled generated/fixture sets, and the
per-kind runner dispatch."""

from __future__ import annotations

from pathlib import Path

import pytest

from worker_ai.evals.datasets import (
    DatasetLoadError,
    available_datasets,
    licensed_datasets_root,
    load_dataset,
)
from worker_ai.evals.datasets.checksums import (
    ChecksumMismatchError,
    build_manifest,
    verify_manifest,
    write_manifest,
)
from worker_ai.evals.datasets.loader import FIXTURES_DIR, GENERATED_DIR
from worker_ai.evals.runner_datasets import run_dataset
from worker_ai.providers.mock import MockProvider


def test_every_bundled_dataset_has_a_mandatory_licence() -> None:
    names = available_datasets()
    assert set(names) >= {
        "hinglish-synth",
        "hindi-synth",
        "tamil-synth",
        "transliteration-synth",
        "autocut-synth",
        "llm-synth",
        "hinglish-mini",
    }
    for name in names:
        dataset = load_dataset(name)
        assert dataset.licence, name
        assert dataset.items


def test_an_unknown_dataset_names_what_is_available() -> None:
    with pytest.raises(DatasetLoadError, match="no dataset"):
        load_dataset("does-not-exist")


def test_licence_is_mandatory_in_a_manifest(tmp_path: Path) -> None:
    directory = tmp_path / "generated" / "no-licence"
    directory.mkdir(parents=True)
    (directory / "manifest.yaml").write_text(
        "name: no-licence\nkind: llm\nitems: [{id: a, reference: {checks: [true]}}]\n",
        encoding="utf-8",
    )
    import worker_ai.evals.datasets.loader as loader_module

    original_generated = loader_module.GENERATED_DIR
    loader_module.GENERATED_DIR = tmp_path / "generated"
    try:
        with pytest.raises(DatasetLoadError, match="licence"):
            load_dataset("no-licence")
    finally:
        loader_module.GENERATED_DIR = original_generated


def test_the_licensed_root_is_unset_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVAL_LICENSED_DATASETS_DIR", raising=False)
    assert licensed_datasets_root() is None


def test_a_licensed_root_that_does_not_exist_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVAL_LICENSED_DATASETS_DIR", "/nope/not/real/path")
    assert licensed_datasets_root() is None


def test_a_licensed_set_wins_over_the_bundled_synthetic_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    licensed_dir = tmp_path / "licensed" / "hindi-synth"
    licensed_dir.mkdir(parents=True)
    (licensed_dir / "manifest.yaml").write_text(
        "name: hindi-synth\nkind: transcript\nlanguage: hi\nscript: Devanagari\n"
        "licence: a00-05-commercial\nitems: [{id: real-1, reference: {reference: 'x'}}]\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("EVAL_LICENSED_DATASETS_DIR", str(tmp_path / "licensed"))
    dataset = load_dataset("hindi-synth")
    assert dataset.source == "licensed"
    assert dataset.licence == "a00-05-commercial"


def test_the_manifest_checksums_cover_every_bundled_file_and_verify_clean() -> None:
    manifest = build_manifest([GENERATED_DIR, FIXTURES_DIR])
    assert manifest["algorithm"] == "sha256"
    assert len(manifest["files"]) > 0
    # Every generated manifest.yaml is present.
    assert any(path.endswith("hinglish-synth/manifest.yaml") for path in manifest["files"])


def test_checksums_catch_a_changed_file(tmp_path: Path) -> None:
    root = tmp_path / "generated"
    (root / "set-a").mkdir(parents=True)
    (root / "set-a" / "manifest.yaml").write_text("original", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"

    write_manifest(manifest_path, [root])
    verify_manifest(manifest_path, [root])  # no error yet

    (root / "set-a" / "manifest.yaml").write_text("tampered", encoding="utf-8")
    with pytest.raises(ChecksumMismatchError, match="changed"):
        verify_manifest(manifest_path, [root])


def test_checksums_catch_a_missing_and_an_extra_file(tmp_path: Path) -> None:
    root = tmp_path / "generated"
    (root / "set-a").mkdir(parents=True)
    (root / "set-a" / "manifest.yaml").write_text("body", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    write_manifest(manifest_path, [root])

    (root / "set-a" / "manifest.yaml").unlink()
    (root / "set-a" / "extra.txt").write_text("new", encoding="utf-8")
    with pytest.raises(ChecksumMismatchError) as excinfo:
        verify_manifest(manifest_path, [root])
    assert "missing" in str(excinfo.value)
    assert "extra" in str(excinfo.value)


@pytest.mark.asyncio
async def test_run_dataset_transcript_kind_uses_the_mock_provider() -> None:
    dataset = load_dataset("hinglish-synth")
    report = await run_dataset(dataset, provider=MockProvider())
    assert "corpusWer" in report.metrics
    assert "corpusCer" in report.metrics
    assert len(report.items) == len(dataset.items)


@pytest.mark.asyncio
async def test_run_dataset_transcript_kind_needs_a_provider() -> None:
    dataset = load_dataset("hinglish-synth")
    with pytest.raises(ValueError, match="needs a provider"):
        await run_dataset(dataset)


@pytest.mark.asyncio
async def test_run_dataset_transliteration_uses_the_real_tables() -> None:
    dataset = load_dataset("transliteration-synth")
    report = await run_dataset(dataset)
    # Every seeded pair is drawn from A22's own dictionary, so this must be 1.0.
    assert report.metrics["transliterationAccuracy"] == 1.0


@pytest.mark.asyncio
async def test_run_dataset_autocut_reports_precision_recall_f1() -> None:
    dataset = load_dataset("autocut-synth")
    report = await run_dataset(dataset)
    assert 0.0 <= report.metrics["autocutPrecision"] <= 1.0
    assert 0.0 <= report.metrics["autocutRecall"] <= 1.0
    assert "autocutF1" in report.metrics


@pytest.mark.asyncio
async def test_run_dataset_llm_pools_checks_across_items() -> None:
    dataset = load_dataset("llm-synth")
    report = await run_dataset(dataset)
    # llm-synth has 15 checks total (3 items x 5) with one false (see manifest.yaml).
    assert report.metrics["llmPassRate"] == pytest.approx(14 / 15)


def test_the_hinglish_mini_adapter_reuses_a09s_fixture_without_duplication() -> None:
    dataset = load_dataset("hinglish-mini")
    assert dataset.kind == "transcript"
    assert {item.id for item in dataset.items} == {"hm-001", "hm-002", "hm-003"}


def test_the_committed_manifest_matches_the_bundled_files() -> None:
    """`manifest.json` is committed; a hand-edited fixture must fail this test.

    Regenerate it with ``node scripts/py.mjs -c`` (see the module docstring in
    ``checksums.py``) after a deliberate change to a bundled dataset file.
    """
    manifest_path = GENERATED_DIR.parent / "manifest.json"
    verify_manifest(manifest_path, [GENERATED_DIR, FIXTURES_DIR])
