"""Region pinning per workspace jurisdiction (brief section 2, THREAT-MODEL T24).

A workspace's `region` (`in`/`eu`/`us`, `apps/api/prisma/schema.prisma`'s
`Region` enum) says where its data may be processed. This module is the single
place that turns a `(provider, region)` pair into "may this call happen" —
apps/api never calls a provider directly, so pinning here is the only gate that
matters, and it fails CLOSED: an unrecognised region, or a region none of the
configured providers can serve, blocks the call rather than falling back to
some default endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass

from worker_ai.llm.providers.base import LlmProvider

__all__ = ["RegionBlockedError", "select_region_compliant_provider"]

KNOWN_REGIONS = frozenset({"in", "eu", "us"})


class RegionBlockedError(RuntimeError):
    """No configured provider may serve this workspace's region."""

    def __init__(self, region: str, tried: tuple[str, ...]) -> None:
        super().__init__(
            f"no LLM provider is configured for region={region!r} "
            f"(tried: {', '.join(tried) if tried else 'none'})"
        )
        self.region = region
        self.tried = tried


@dataclass(frozen=True, slots=True)
class RegionDecision:
    provider: LlmProvider
    region: str


def select_region_compliant_provider(
    providers: tuple[LlmProvider, ...], region: str
) -> RegionDecision:
    """The first provider (in priority order) that may serve ``region``.

    :raises RegionBlockedError: when the region is unknown, or no provider in
        ``providers`` supports it — an EU workspace must never silently fall
        through to a non-EU endpoint (acceptance criterion 2).
    """
    if region not in KNOWN_REGIONS:
        raise RegionBlockedError(region, tuple(p.name for p in providers))
    for provider in providers:
        if provider.supports_region(region):
            return RegionDecision(provider=provider, region=region)
    raise RegionBlockedError(region, tuple(p.name for p in providers))
