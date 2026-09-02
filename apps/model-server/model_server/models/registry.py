"""The warm pool: three backends, loaded once at startup, never per request.

The rule this file exists to enforce is one line long — **no request ever
triggers a model load** — and it is the difference between a 25 to 40 second cold start
paid once (``infra/gpu/COST.md §4``) and one paid per request. So:

* :meth:`ModelRegistry.load` runs inside the app's lifespan startup, before the
  first request can be accepted, and ``/readyz`` is false until it finishes.
* A backend that fails to load does **not** take the process down. On a serverless
  worker a hard exit is a crash loop that still bills; instead the failure is
  recorded, ``model_server_model_ready`` stays at 0 for that model, its routes
  answer 503 with the reason, and the other two keep serving. A ``/transcribe``
  that works while ``/diarise`` cannot is strictly better than neither.
* ``MODEL_SERVER_PRELOAD`` selects **which backends are loaded at all**, and
  readiness requires exactly those. A backend left out is never instantiated, so
  a CPU lane that only transcribes does not pay to page pyannote into memory, and
  its ``/diarise`` answers 503 naming the reason rather than pretending. The CUDA
  image preloads all three.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from model_server.logging_setup import get_logger
from model_server.metrics import Metrics
from model_server.models.base import AlignerBackend, AsrBackend, Backend, DiariserBackend
from model_server.settings import Settings

__all__ = ["ModelRegistry", "ModelStatus"]

_log = get_logger(__name__)


@dataclass(slots=True)
class ModelStatus:
    """What happened when one backend tried to load."""

    kind: str
    model_id: str
    ready: bool = False
    load_seconds: float = 0.0
    error: str = ""


@dataclass(slots=True)
class ModelRegistry:
    """The three co-resident models, plus what is known about each one."""

    asr: AsrBackend | None = None
    aligner: AlignerBackend | None = None
    diariser: DiariserBackend | None = None
    statuses: dict[str, ModelStatus] = field(default_factory=dict)
    #: Backends whose readiness gates ``/readyz``.
    required: tuple[str, ...] = ("asr",)

    # -- construction -------------------------------------------------------

    @classmethod
    def from_settings(cls, settings: Settings) -> ModelRegistry:
        """Build the real backends. Nothing is imported until :meth:`load`."""
        from model_server.models.aligner import CtcAligner
        from model_server.models.diariser import PyannoteDiariser
        from model_server.models.whisper import FasterWhisperAsr

        return cls(
            asr=FasterWhisperAsr(
                settings.whisper_model,
                device=settings.device,
                compute_type=settings.effective_compute_type,
                download_root=settings.model_cache_dir,
            ),
            aligner=CtcAligner(settings.align_model_dir, device=settings.device),
            diariser=PyannoteDiariser(settings.diariser_model, device=settings.device),
            required=settings.preload,
        )

    # -- lifecycle ----------------------------------------------------------

    def backends(self) -> dict[str, Backend | None]:
        return {"asr": self.asr, "align": self.aligner, "diarise": self.diariser}

    def load(self, *, device: str = "cpu", metrics: Metrics | None = None) -> None:
        """Load the backends named in ``required``, recording success and failure alike."""
        for kind, backend in self.backends().items():
            if backend is None:
                continue
            status = ModelStatus(kind=kind, model_id=backend.model_id)
            self.statuses[kind] = status
            if kind not in self.required:
                # Not selected for this worker: never instantiated, so it costs
                # nothing, and its routes answer 503 with this sentence.
                status.error = kind + " is not in MODEL_SERVER_PRELOAD on this worker"
                if metrics is not None:
                    metrics.model_ready.labels(model=kind).set(0.0)
                continue
            reason = backend.unavailable()
            if reason is not None:
                status.error = reason
                _log.warning("model backend unavailable", extra={"kind": kind, "reason": reason})
            else:
                started = time.perf_counter()
                try:
                    backend.load()
                except Exception as error:  # one model down is not the process down
                    status.error = type(error).__name__ + ": " + str(error)
                    _log.error(
                        "model backend failed to load",
                        extra={"kind": kind, "model": backend.model_id},
                        exc_info=True,
                    )
                else:
                    status.ready = backend.ready
                    status.load_seconds = round(time.perf_counter() - started, 3)
            if metrics is not None:
                metrics.model_ready.labels(model=kind).set(1.0 if status.ready else 0.0)
                metrics.model_load_seconds.labels(model=kind, device=device).set(
                    status.load_seconds
                )

    def unload(self) -> None:
        """Release every backend. Idempotent."""
        for kind, backend in self.backends().items():
            if backend is None:
                continue
            backend.unload()
            status = self.statuses.get(kind)
            if status is not None:
                status.ready = False

    # -- readiness ----------------------------------------------------------

    def ready(self) -> bool:
        """True when every backend named in ``MODEL_SERVER_PRELOAD`` is resident."""
        return all(self.statuses.get(kind, ModelStatus(kind, "")).ready for kind in self.required)

    def not_ready_reason(self) -> str:
        """Which required backends are missing, and why, for ``/readyz``'s body."""
        problems = []
        for kind in self.required:
            status = self.statuses.get(kind)
            if status is None:
                problems.append(kind + ": not loaded")
            elif not status.ready:
                problems.append(kind + ": " + (status.error or "still loading"))
        return "; ".join(problems)

    def engine_versions(self) -> dict[str, str]:
        """Every loaded backend's ``engineVersions`` fragment, merged."""
        versions: dict[str, str] = {}
        for backend in self.backends().values():
            if backend is not None and backend.ready:
                versions.update(backend.engine_versions())
        return versions

    def status_payload(self) -> dict[str, object]:
        """The body of ``/readyz``: what is resident, what is not, and why."""
        return {
            "ready": self.ready(),
            "required": list(self.required),
            "models": {
                kind: {
                    "model": status.model_id,
                    "ready": status.ready,
                    "loadSeconds": status.load_seconds,
                    **({"error": status.error} if status.error else {}),
                }
                for kind, status in self.statuses.items()
            },
        }
