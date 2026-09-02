#!/usr/bin/env python3
"""Enforce **both** halves of the CONTRACTS section 9 coverage gate.

`docs/CONTRACTS.md` section 9 states the gate for a Python app as **75 lines /
70 branches**. ``pytest-cov``'s ``--cov-fail-under`` takes a single number and
applies it to a *blended* figure, so a run with 95 % of lines and 40 % of
branches passes it comfortably while failing the contract. This script reads the
JSON report and checks the two numbers separately.

Run after pytest (``pnpm --filter @montaj/model-server test`` does both):

    python -m pytest -q
    python scripts/coverage_gate.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

#: CONTRACTS section 9: apps/api, worker-media, render and worker-ai are 75/70,
#: and a new Python app joins them.
LINE_THRESHOLD = 75.0
BRANCH_THRESHOLD = 70.0

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "coverage.json"


def _write_report() -> None:
    """Render ``.coverage`` (written by the pytest run) as JSON."""
    subprocess.run(  # noqa: S603 - argv list, sys.executable, no shell
        [sys.executable, "-m", "coverage", "json", "-o", str(REPORT)],
        cwd=str(ROOT),
        check=True,
        capture_output=True,
    )


def main() -> int:
    if not (ROOT / ".coverage").is_file():
        print("coverage_gate: no .coverage file; run pytest first", file=sys.stderr)
        return 2
    _write_report()
    totals = json.loads(REPORT.read_text(encoding="utf-8"))["totals"]
    REPORT.unlink(missing_ok=True)

    statements = int(totals["num_statements"]) or 1
    branches = int(totals["num_branches"]) or 1
    lines_pct = 100.0 * int(totals["covered_lines"]) / statements
    branch_pct = 100.0 * int(totals["covered_branches"]) / branches

    print(
        "coverage_gate: lines "
        + format(lines_pct, ".2f")
        + "% (need "
        + format(LINE_THRESHOLD, ".0f")
        + "%), branches "
        + format(branch_pct, ".2f")
        + "% (need "
        + format(BRANCH_THRESHOLD, ".0f")
        + "%)"
    )

    failures = []
    if lines_pct < LINE_THRESHOLD:
        failures.append("line coverage " + format(lines_pct, ".2f") + "%")
    if branch_pct < BRANCH_THRESHOLD:
        failures.append("branch coverage " + format(branch_pct, ".2f") + "%")
    if failures:
        print(
            "coverage_gate: below the CONTRACTS section 9 gate: " + ", ".join(failures),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
