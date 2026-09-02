"""Aksharo — works with DaVinci Resolve: Workspace > Scripts entry point.

Installed by C10 to Fusion's `Scripts/Utility` folder (this exact filename,
`aksharo_core`, is what shows in the Workspace > Scripts menu — D65 naming;
`packages/config/src/brand.ts`'s `PLUGIN_IDS.resolveScript`). Running it from
that menu is the only path that reaches DaVinci Resolve **Free** users;
external scripting is Studio-only (D22).

This file is intentionally a thin bootstrap: DaVinci Resolve `exec`s a single
flat `.py` file here, so all the real, unit-tested logic lives in the sibling
`aksharo_core_app/` package (installed alongside this file by C10) rather than
in a same-named package directory, which Python's import system would not let
coexist with this file under one name.

Blocked on human spike A00-04 (`docs/PLAN.md`): whether a Utility script
receives the `resolve` global on Free the same way Studio does, whether a
loopback server can run inside the Resolve process, and whether Text+ macro
insertion behaves as this package assumes. Until that spike reports, this
bootstrap only prints the banner and a clear "not yet connected" message
rather than guessing at unverified behaviour.
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_lib_on_path() -> None:
    """Resolve places this file's own directory first on `sys.path` when it
    execs a Utility script, but pin it explicitly so `aksharo_core_app` (its
    sibling directory, installed alongside this file) always resolves."""
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))


def main() -> None:
    _ensure_lib_on_path()
    from aksharo_core_app.console import print_banner

    print_banner()

    resolve = globals().get("resolve")
    if resolve is None:
        print(
            "No `resolve` object in this script's namespace — run this from "
            "DaVinci Resolve's Workspace > Scripts menu, not a plain python "
            "interpreter. (A00-04 will confirm this path on Free vs Studio.)"
        )
        return

    from aksharo_core_app.host.resolve import RealResolveHost

    try:
        RealResolveHost()
    except RuntimeError as exc:
        print(f"Aksharo could not start: {exc}")
        return

    print(
        "Aksharo core is scaffolded but the live Resolve wiring "
        "(loopback server start, bridge pairing) is pending A00-04's report; "
        "see plugins/resolve/README.md."
    )


if __name__ == "__main__":
    main()
