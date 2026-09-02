"""Aksharo — works with DaVinci Resolve (C08).

This package is the testable core behind the `aksharo_core.py` Resolve entry
script (installed to Fusion's `Scripts/Utility` by C10, D65 naming). It is
importable and unit-testable on any machine, including this CI host, which has
no DaVinci Resolve installed: every call into the real `DaVinciResolveScript`
module is isolated in `aksharo_core_app.host.resolve`, imported lazily, and
everything else here is exercised against `FakeResolve`.

Non-affiliation: Aksharo is an independent product that works with DaVinci
Resolve; it is not made, endorsed, or supported by Blackmagic Design.
"""

from aksharo_core_app.console import BANNER, NON_AFFILIATION_LINE

__all__ = ["BANNER", "NON_AFFILIATION_LINE"]
