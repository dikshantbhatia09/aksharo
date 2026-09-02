#!/usr/bin/env python
"""Regenerate `aksharo_core_app/fusion/AksharoCaption.setting` (checked into the
repo; deterministic — `tests/test_fusion_macro.py` fails if this drifts from
the module that generates it)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aksharo_core_app.fusion.macro import generate_default_macro, macro_path


def main() -> None:
    text = generate_default_macro()
    path = macro_path()
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
