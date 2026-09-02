"""The ``model_server_*`` series, exactly as registered in METRICS.md section 11.

Native Prometheus names, not OTel names: a RunPod or Modal sandbox has no
collector beside it, so this process is scraped directly and what is defined here
is what a scrape returns. Renaming one of these is an ADR, not a refactor — a
dashboard panel bound to a missing series looks exactly like a healthy zero.

The registry is created per process rather than taken from ``prometheus_client``'s
global default, so a test can build an app, assert on its counters and throw it
away without the next test inheriting the numbers.
"""

from __future__ import annotations

from dataclasses import dataclass

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, disable_created_metrics

__all__ = ["Metrics"]

_DURATION_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0)
_WAIT_BUCKETS = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25)
_BATCH_BUCKETS = (1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0)
_RTF_BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0)


@dataclass(slots=True)
class Metrics:
    """Every series this app publishes, bound to one registry."""

    registry: CollectorRegistry
    requests: Counter
    request_duration: Histogram
    audio_seconds: Counter
    compute_seconds: Counter
    realtime_factor: Histogram
    batch_size: Histogram
    batch_wait: Histogram
    inflight: Gauge
    rejected: Counter
    memory_reserved: Gauge
    memory_budget: Gauge
    model_load_seconds: Gauge
    model_ready: Gauge
    draining: Gauge

    @classmethod
    def create(cls, registry: CollectorRegistry | None = None) -> Metrics:
        """Build the full set on a fresh registry."""
        # `*_created` series are a per-counter creation timestamp that no
        # dashboard here reads and that METRICS.md does not register. Off, so a
        # scrape contains exactly the names in the contract.
        # prometheus_client ships this helper unannotated; the ignore is on the
        # call, not on the module, so everything else stays type-checked.
        disable_created_metrics()  # type: ignore[no-untyped-call]
        target = registry if registry is not None else CollectorRegistry()
        return cls(
            registry=target,
            requests=Counter(
                "model_server_requests",
                "Requests served, by route and HTTP status.",
                ("route", "status"),
                registry=target,
            ),
            request_duration=Histogram(
                "model_server_request_duration_seconds",
                "Wall-clock request duration inside the app, batch wait included.",
                ("route", "status"),
                buckets=_DURATION_BUCKETS,
                registry=target,
            ),
            audio_seconds=Counter(
                "model_server_audio_seconds",
                "Media seconds decoded and processed.",
                ("route", "model"),
                registry=target,
            ),
            compute_seconds=Counter(
                "model_server_compute_seconds",
                "Seconds of model compute attributed to a request (usage.gpuSeconds).",
                ("route", "model", "device"),
                registry=target,
            ),
            realtime_factor=Histogram(
                "model_server_realtime_factor",
                "Compute seconds divided by audio seconds. D74 assumes 0.055.",
                ("route", "model", "device"),
                buckets=_RTF_BUCKETS,
                registry=target,
            ),
            batch_size=Histogram(
                "model_server_batch_size",
                "Requests coalesced into one model call.",
                ("route", "model"),
                buckets=_BATCH_BUCKETS,
                registry=target,
            ),
            batch_wait=Histogram(
                "model_server_batch_wait_seconds",
                "Time a request waited in the batch window before its call started.",
                ("route",),
                buckets=_WAIT_BUCKETS,
                registry=target,
            ),
            inflight=Gauge(
                "model_server_inflight_requests",
                "Requests admitted and not yet answered.",
                ("route",),
                registry=target,
            ),
            rejected=Counter(
                "model_server_rejected",
                "Requests refused before any model ran.",
                ("reason",),
                registry=target,
            ),
            memory_reserved=Gauge(
                "model_server_memory_reserved_bytes",
                "Bytes the memory guard currently holds against the budget.",
                registry=target,
            ),
            memory_budget=Gauge(
                "model_server_memory_budget_bytes",
                "The memory guard's ceiling.",
                registry=target,
            ),
            model_load_seconds=Gauge(
                "model_server_model_load_seconds",
                "How long each model took to load at startup.",
                ("model", "device"),
                registry=target,
            ),
            model_ready=Gauge(
                "model_server_model_ready",
                "1 when the model is resident and serving.",
                ("model",),
                registry=target,
            ),
            draining=Gauge(
                "model_server_draining",
                "1 once SIGTERM has been received and in-flight work is finishing.",
                registry=target,
            ),
        )

    def observe_usage(
        self, *, route: str, model: str, device: str, audio_seconds: float, compute_seconds: float
    ) -> None:
        """Record one request's cost counters and its realtime factor."""
        self.audio_seconds.labels(route=route, model=model).inc(audio_seconds)
        self.compute_seconds.labels(route=route, model=model, device=device).inc(compute_seconds)
        if audio_seconds > 0:
            self.realtime_factor.labels(route=route, model=model, device=device).observe(
                compute_seconds / audio_seconds
            )
