"""Typed adapter over the DaVinci Resolve scripting object model.

`resolve.py` is the ONLY module in this package allowed to import the real
`DaVinciResolveScript` module (lazily, at call time). Everything else in
`aksharo_core_app` depends only on the `ResolveHost` protocol defined there,
so it is unit-testable against `FakeResolve` on a machine with no Resolve
installed (this CI host included).
"""
