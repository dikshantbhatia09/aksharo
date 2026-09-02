"""Console banner shown in Resolve's script console on startup (D65 naming)."""

from __future__ import annotations

PRODUCT_NAME = "Aksharo — works with DaVinci Resolve"

NON_AFFILIATION_LINE = (
    "Aksharo is an independent product that works with DaVinci Resolve. "
    "It is not made, endorsed, or supported by Blackmagic Design."
)

BANNER = f"{PRODUCT_NAME}\n{NON_AFFILIATION_LINE}"


def print_banner() -> None:
    """Print the startup banner to the Resolve console (stdout)."""
    print(BANNER)
