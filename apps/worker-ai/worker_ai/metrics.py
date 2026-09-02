"""Per-provider, per-language counters for the control port (`09 §1`, `09 §8`).

`09 §1` asks every stage to "emit latency, cost and quality metrics tagged by
provider and language", and `09 §8`'s admin leaderboard is per language and cost.
This is the smallest thing that answers both: four counters and one histogram-free
duration sum, in process memory, rendered as Prometheus text on the pod-internal
control port that X05's scrape config already reaches.

Deliberately **not** a Prometheus client library. The worker has one dependency
budget and a counter dictionary is forty lines; the shapes below are the standard
exposition format, so a real client can replace this without changing a
dashboard. Counters reset when the pod restarts, which is what a counter is
supposed to do — Prometheus handles the reset.

Nothing here is ever labelled with a workspace, a project or a media id. A metric
label is a cardinality bomb and a privacy leak in the same field (THREAT-MODEL
T21); provider, language, lane and outcome are all bounded sets.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

__all__ = ["METRICS", "AsrMetrics", "MetricKey"]


@dataclass(frozen=True, slots=True)
class MetricKey:
    """The label set every ASR counter carries."""

    provider: str
    language: str
    lane: str

    def labels(self, **extra: str) -> str:
        pairs = {
            "provider": self.provider or "unknown",
            "language": self.language or "unknown",
            "lane": self.lane or "unknown",
            **extra,
        }
        return ",".join(key + '="' + _escape(value) + '"' for key, value in sorted(pairs.items()))


@dataclass(slots=True)
class AsrMetrics:
    """Counters for the ASR path, tagged by provider, language and lane."""

    calls: dict[tuple[MetricKey, str], int] = field(default_factory=dict)
    media_seconds: dict[MetricKey, float] = field(default_factory=dict)
    cost_minor: dict[MetricKey, int] = field(default_factory=dict)
    cache: dict[str, int] = field(default_factory=dict)
    fallbacks: dict[tuple[str, str], int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def record_call(
        self,
        key: MetricKey,
        *,
        outcome: str,
        media_seconds: float = 0.0,
        cost_minor: int = 0,
    ) -> None:
        """One provider call: its outcome, the media it consumed and what it cost."""
        with self._lock:
            self.calls[(key, outcome)] = self.calls.get((key, outcome), 0) + 1
            if media_seconds:
                self.media_seconds[key] = self.media_seconds.get(key, 0.0) + media_seconds
            if cost_minor:
                self.cost_minor[key] = self.cost_minor.get(key, 0) + cost_minor

    def record_cache(self, *, hit: bool) -> None:
        with self._lock:
            name = "hit" if hit else "miss"
            self.cache[name] = self.cache.get(name, 0) + 1

    def record_fallback(self, *, from_provider: str, to_provider: str) -> None:
        """A vendor failed and routing advanced down the chain (`09 §1`)."""
        with self._lock:
            pair = (from_provider, to_provider)
            self.fallbacks[pair] = self.fallbacks.get(pair, 0) + 1

    def reset(self) -> None:
        """Clear every counter — used by tests, never in production."""
        with self._lock:
            self.calls.clear()
            self.media_seconds.clear()
            self.cost_minor.clear()
            self.cache.clear()
            self.fallbacks.clear()

    def snapshot(self) -> dict[str, Any]:
        """The counters as JSON, for ``GET /providers``."""
        with self._lock:
            return {
                "calls": [
                    {
                        "provider": key.provider,
                        "language": key.language,
                        "lane": key.lane,
                        "outcome": outcome,
                        "count": count,
                    }
                    for (key, outcome), count in sorted(
                        self.calls.items(), key=lambda item: (item[0][0].provider, item[0][1])
                    )
                ],
                "cache": dict(sorted(self.cache.items())),
                "fallbacks": [
                    {"from": pair[0], "to": pair[1], "count": count}
                    for pair, count in sorted(self.fallbacks.items())
                ],
                "costMinor": [
                    {"provider": key.provider, "language": key.language, "minor": value}
                    for key, value in sorted(
                        self.cost_minor.items(), key=lambda item: item[0].provider
                    )
                ],
            }

    def render(self) -> str:
        """Prometheus text exposition (version 0.0.4)."""
        lines: list[str] = []
        with self._lock:
            lines.append("# HELP montaj_asr_calls_total ASR provider calls by outcome.")
            lines.append("# TYPE montaj_asr_calls_total counter")
            for (key, outcome), count in sorted(
                self.calls.items(), key=lambda item: (item[0][0].provider, item[0][1])
            ):
                lines.append(
                    "montaj_asr_calls_total{" + key.labels(outcome=outcome) + "} " + str(count)
                )

            lines.append("# HELP montaj_asr_media_seconds_total Media seconds sent to a provider.")
            lines.append("# TYPE montaj_asr_media_seconds_total counter")
            for key, seconds in sorted(
                self.media_seconds.items(), key=lambda item: item[0].provider
            ):
                lines.append(
                    "montaj_asr_media_seconds_total{" + key.labels() + "} " + str(round(seconds, 3))
                )

            lines.append("# HELP montaj_asr_cost_minor_total Estimated list price, in paise.")
            lines.append("# TYPE montaj_asr_cost_minor_total counter")
            for key, minor in sorted(self.cost_minor.items(), key=lambda item: item[0].provider):
                lines.append("montaj_asr_cost_minor_total{" + key.labels() + "} " + str(minor))

            lines.append("# HELP montaj_asr_cache_total Result cache lookups (`09 §1`).")
            lines.append("# TYPE montaj_asr_cache_total counter")
            for outcome, count in sorted(self.cache.items()):
                lines.append(
                    'montaj_asr_cache_total{outcome="' + _escape(outcome) + '"} ' + str(count)
                )

            lines.append("# HELP montaj_asr_fallbacks_total Routing fallbacks after an error.")
            lines.append("# TYPE montaj_asr_fallbacks_total counter")
            for (source, target), count in sorted(self.fallbacks.items()):
                lines.append(
                    'montaj_asr_fallbacks_total{from="'
                    + _escape(source)
                    + '",to="'
                    + _escape(target)
                    + '"} '
                    + str(count)
                )
        return "\n".join(lines) + "\n"


def _escape(value: str) -> str:
    """Prometheus label-value escaping."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


#: One registry per process; the worker and the control app share it.
METRICS = AsrMetrics()
