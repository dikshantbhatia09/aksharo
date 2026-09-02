"""The nightly eval job (`09 §8`, D08 §5): every bundled dataset, scored on the
CPU lane, written to ``eval-results/<date>/report.{json,md}`` and posted to the
API's leaderboard.

**Cost-capped, per D74.** The CPU lane runs `MODEL_SERVER_BATCH_MAX_SIZE=1`
(A26's deployment rule — batching only helps on a GPU), and this job caps
*dataset size* on top of that: :data:`DEFAULT_MAX_ITEMS_PER_DATASET` items per
dataset per run, so a nightly run's cost is bounded independent of how large a
future licensed dataset (A00-05) turns out to be. Real vendor providers are
never called here — only ``mock`` (for the bundled synthetic sets) and the
per-vendor recorded replay sessions A09 ships (:mod:`worker_ai.evals.replay`);
a live vendor call needs ``--live``, which this module does not expose,
because "never in CI" (this WP's brief) is the whole point of a nightly job
that must run unattended.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx2

from worker_ai.callbacks import encode_body, signature_headers
from worker_ai.evals.datasets import Dataset, DatasetLoadError, available_datasets, load_dataset
from worker_ai.evals.runner_datasets import DatasetReport, run_dataset
from worker_ai.providers.base import Provider
from worker_ai.providers.mock import MockProvider
from worker_ai.routing import is_routing_frozen

__all__ = [
    "DEFAULT_MAX_ITEMS_PER_DATASET",
    "DEFAULT_RESULTS_DIR",
    "NightlyReport",
    "post_nightly_report",
    "run_nightly",
    "write_report",
]

#: `09 §8`/D74: the per-dataset cost cap for the CPU-lane nightly run.
DEFAULT_MAX_ITEMS_PER_DATASET = 50

#: `eval-results/<date>/report.{json,md}`, shipped alongside the worker package
#: root (not inside `worker_ai/`, so it is never mistaken for a bundled fixture
#: and is easy for an operator to find without importing anything).
DEFAULT_RESULTS_DIR = Path(__file__).resolve().parents[2] / "eval-results"

#: `09 §8`/D61: 90-day retention. The API enforces the actual deletion
#: (`eval_runs`/`eval_results` rows); this constant documents the same number
#: for the report writer's own retrospective housekeeping (see `write_report`).
RETENTION_DAYS = 90


@dataclass(frozen=True, slots=True)
class NightlyReport:
    """One nightly run across every dataset the harness knows about."""

    date: str
    trigger: str
    started_at: str
    finished_at: str
    routing_frozen: bool
    datasets: tuple[DatasetReport, ...]
    skipped: tuple[tuple[str, str], ...] = ()
    git_sha: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "date": self.date,
            "trigger": self.trigger,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "routingFrozen": self.routing_frozen,
            "gitSha": self.git_sha,
            "datasets": [dataset.to_wire() for dataset in self.datasets],
            "skipped": [{"dataset": name, "reason": reason} for name, reason in self.skipped],
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Eval run — {self.date}",
            "",
            f"- trigger: `{self.trigger}`",
            f"- started: {self.started_at}",
            f"- finished: {self.finished_at}",
            f"- routing frozen: {self.routing_frozen}",
            f"- git sha: {self.git_sha or 'n/a'}",
            "",
            "| dataset | kind | language | metric | value | items |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for dataset in self.datasets:
            for metric_name, value in dataset.metrics.items():
                lines.append(
                    f"| {dataset.dataset_name} | {dataset.kind} | {dataset.language} "
                    f"| {metric_name} | {value:.4f} | {len(dataset.items)} |"
                )
        if self.skipped:
            lines += ["", "## Skipped", ""]
            lines += [f"- **{name}**: {reason}" for name, reason in self.skipped]
        return "\n".join(lines) + "\n"

    def as_result_rows(self) -> list[dict[str, Any]]:
        """Flattened `(dataset, metric)` rows, the shape `POST /internal/evals/runs` wants."""
        rows: list[dict[str, Any]] = []
        for dataset in self.datasets:
            for metric_name, value in dataset.metrics.items():
                rows.append(
                    {
                        "dataset": dataset.dataset_name,
                        "kind": dataset.kind,
                        "language": dataset.language,
                        "metricName": metric_name,
                        "metricValue": round(value, 6),
                        "itemCount": len(dataset.items),
                    }
                )
        return rows


def _provider_for(dataset: Dataset) -> Provider | None:
    """The mock, for a transcript dataset; ``None`` for every other kind.

    A09's recorded vendor-replay sessions (`worker_ai/fixtures/vendor/*`) are
    deliberately not wired in here: the nightly job scores the harness's own
    bundled datasets against the mock so it always runs (no keys, no replay
    fixtures to keep in sync with routing changes), and a vendor comparison is
    what the *shadow* routing mechanism and a manual `--live` run are for.
    """
    if dataset.kind != "transcript":
        return None
    return MockProvider()


async def run_nightly(
    *,
    dataset_names: tuple[str, ...] | None = None,
    max_items_per_dataset: int = DEFAULT_MAX_ITEMS_PER_DATASET,
    trigger: str = "nightly",
    git_sha: str | None = None,
    now: float | None = None,
) -> NightlyReport:
    """Score every named dataset (default: every bundled one) and return a report."""
    started = datetime.fromtimestamp(now if now is not None else time.time(), tz=UTC)
    names = dataset_names if dataset_names is not None else available_datasets()

    reports: list[DatasetReport] = []
    skipped: list[tuple[str, str]] = []
    for name in names:
        try:
            dataset = load_dataset(name)
        except DatasetLoadError as error:
            skipped.append((name, str(error)))
            continue

        capped = dataset
        if len(dataset.items) > max_items_per_dataset:
            capped = replace(dataset, items=dataset.items[:max_items_per_dataset])

        provider = _provider_for(capped)
        try:
            report = await run_dataset(capped, provider=provider)
        except ValueError as error:
            skipped.append((name, str(error)))
            continue
        reports.append(report)
        if provider is not None:
            await provider.aclose()

    finished = datetime.now(tz=UTC)
    return NightlyReport(
        date=started.date().isoformat(),
        trigger=trigger,
        started_at=started.isoformat(),
        finished_at=finished.isoformat(),
        routing_frozen=is_routing_frozen(),
        datasets=tuple(reports),
        skipped=tuple(skipped),
        git_sha=git_sha,
    )


def write_report(report: NightlyReport, *, root: Path | None = None) -> tuple[Path, Path]:
    """Write ``<root>/<date>/report.{json,md}``, returning both paths."""
    base = root or DEFAULT_RESULTS_DIR
    date_dir = base / report.date
    date_dir.mkdir(parents=True, exist_ok=True)
    json_path = date_dir / "report.json"
    md_path = date_dir / "report.md"
    json_path.write_text(json.dumps(report.to_wire(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


async def post_nightly_report(
    report: NightlyReport,
    *,
    api_origin: str,
    secret: str,
    attempt_id: str,
) -> dict[str, Any]:
    """``POST {API_ORIGIN}/internal/evals/runs``, signed like a job completion
    callback (CONTRACTS §3's scheme, reused rather than reinvented).

    Returns the API's parsed JSON response. Raises for a non-2xx response —
    the nightly CLI's job is to fail loudly (and the report is already on disk
    either way, so a failed post never loses the run's data).
    """
    body = {
        "trigger": report.trigger,
        "startedAt": report.started_at,
        "finishedAt": report.finished_at,
        "routingFrozen": report.routing_frozen,
        "gitSha": report.git_sha,
        "summary": {
            "datasetsRun": [dataset.dataset_name for dataset in report.datasets],
            "datasetsSkipped": [
                {"name": name, "reason": reason} for name, reason in report.skipped
            ],
        },
        "results": report.as_result_rows(),
    }
    encoded = encode_body(body)
    headers = signature_headers(secret=secret, attempt_id=attempt_id, body=encoded)
    url = f"{api_origin.rstrip('/')}/internal/evals/runs"
    async with httpx2.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, content=encoded, headers=headers)
        response.raise_for_status()
        return dict(response.json())
