#!/usr/bin/env python
"""Regenerate `docs/RESOLVE-STYLE-COVERAGE.md` from the 30
`@montaj/caption-styles` documents and `@montaj/fonts`'s bundled manifest.
Deterministic — `tests/test_fusion_style_map.py` calls the same function and
checks it is stable across repeated calls."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aksharo_core_app.fusion.style_map import write_coverage_report


def main() -> None:
    write_coverage_report()
    print("wrote docs/RESOLVE-STYLE-COVERAGE.md")


if __name__ == "__main__":
    main()
