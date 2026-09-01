"""Provider registry: which adapters exist, which are enabled, and why not.

A provider is **enabled** when three things hold:

1. its adapter is implemented (A10 shells are registered but never enabled);
2. every credential it needs is present in the environment;
3. its feature flag is not switched off — ``asr.<name>`` in ``FEATURE_FLAGS_JSON``.

Anything else is reported with a reason rather than hidden, because "why is the
Hinglish lane running on the mock?" has to be answerable from ``GET /providers``
on the pod, without a redeploy.

Instances are created lazily and cached: building a client is cheap, but loading
a local Whisper model is not, and a worker that consumes only ``ai.align`` should
never pay for one.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from worker_ai.logging_setup import get_logger
from worker_ai.providers.assemblyai import AssemblyAiProvider
from worker_ai.providers.base import Provider, ProviderCapability
from worker_ai.providers.elevenlabs import ElevenLabsScribeProvider
from worker_ai.providers.local_whisper import LocalWhisperProvider
from worker_ai.providers.mock import MockProvider
from worker_ai.providers.sarvam import SarvamSaarasProvider
from worker_ai.providers.serverless_whisper import ServerlessWhisperProvider
from worker_ai.settings import Settings

__all__ = [
    "ProviderRegistry",
    "ProviderStatus",
    "ProviderUnavailableError",
    "build_registry",
]

_log = get_logger(__name__)


class ProviderUnavailableError(RuntimeError):
    """A provider was asked for but is not enabled here."""

    def __init__(self, name: str, reason: str) -> None:
        super().__init__(f"provider {name!r} is unavailable: {reason}")
        self.provider = name
        self.reason = reason


@dataclass(frozen=True, slots=True)
class ProviderStatus:
    """One row of ``GET /providers``."""

    name: str
    enabled: bool
    implemented: bool
    #: Why it is disabled; ``None`` when it is enabled.
    reason: str | None
    capabilities: dict[str, Any]
    cost_per_minute_inr: float
    flag: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "enabled": self.enabled,
            "implemented": self.implemented,
            "reason": self.reason,
            "flag": self.flag,
            "capabilities": self.capabilities,
            "costPerMinuteInr": self.cost_per_minute_inr,
        }


@dataclass(frozen=True, slots=True)
class _Registration:
    name: str
    factory: Callable[[], Provider]
    template: Provider
    implemented: bool
    #: Callable returning ``None`` when configured, or the reason it is not.
    unmet: Callable[[], str | None]

    @property
    def flag(self) -> str:
        return f"asr.{self.name}"


class ProviderRegistry:
    """Every known adapter, with its enablement decision and a lazy instance cache."""

    def __init__(self, settings: Settings, registrations: tuple[_Registration, ...]) -> None:
        self._settings = settings
        self._registrations = {item.name: item for item in registrations}
        self._instances: dict[str, Provider] = {}
        self._lock = asyncio.Lock()

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._registrations)

    def reason_disabled(self, name: str) -> str | None:
        """``None`` when the provider may be used, otherwise a one-line reason."""
        registration = self._registrations.get(name)
        if registration is None:
            return "no adapter is registered under that name"
        if not registration.implemented:
            return "the adapter lands in A10"
        if not self._settings.flag(registration.flag, default=True):
            return f"feature flag {registration.flag} is off"
        return registration.unmet()

    def enabled(self, name: str) -> bool:
        return self.reason_disabled(name) is None

    def describe(self) -> tuple[ProviderStatus, ...]:
        """Every provider and its state, in registration order."""
        rows: list[ProviderStatus] = []
        for registration in self._registrations.values():
            reason = self.reason_disabled(registration.name)
            rows.append(
                ProviderStatus(
                    name=registration.name,
                    enabled=reason is None,
                    implemented=registration.implemented,
                    reason=reason,
                    capabilities=registration.template.capabilities.to_wire(),
                    cost_per_minute_inr=registration.template.cost_per_minute_inr,
                    flag=registration.flag,
                )
            )
        return tuple(rows)

    def supports(self, name: str, capability: ProviderCapability) -> bool:
        """True when an enabled ``name`` implements ``capability``."""
        registration = self._registrations.get(name)
        if registration is None or not self.enabled(name):
            return False
        return registration.template.supports(capability)

    async def get(self, name: str) -> Provider:
        """The cached instance of ``name``.

        :raises ProviderUnavailableError: when it is not enabled here.
        """
        reason = self.reason_disabled(name)
        if reason is not None:
            raise ProviderUnavailableError(name, reason)
        async with self._lock:
            instance = self._instances.get(name)
            if instance is None:
                instance = self._registrations[name].factory()
                self._instances[name] = instance
                _log.debug("provider instantiated", extra={"provider": name})
            return instance

    async def aclose(self) -> None:
        """Close every instantiated adapter."""
        instances = list(self._instances.values())
        self._instances.clear()
        for instance in instances:
            await instance.aclose()


def build_registry(settings: Settings) -> ProviderRegistry:
    """The registry for one worker process, from the validated environment."""

    def credential(value: str, variable: str) -> Callable[[], str | None]:
        return lambda: None if value else f"{variable} is not set"

    registrations = (
        _Registration(
            name="mock",
            factory=MockProvider,
            template=MockProvider(),
            implemented=True,
            # Never a production lane: the routing resolver only reaches it when
            # `Settings.mock_allowed` says this deployment has nothing better.
            unmet=lambda: (
                None
                if settings.mock_allowed
                else "a real ASR provider is configured; set WORKER_AI_ALLOW_MOCK=1 to force it"
            ),
        ),
        _Registration(
            name="local-whisper",
            factory=lambda: LocalWhisperProvider(model_name=settings.whisper_model),
            template=LocalWhisperProvider(),
            implemented=True,
            unmet=_faster_whisper_missing,
        ),
        _Registration(
            name="serverless-whisper",
            factory=lambda: ServerlessWhisperProvider(
                settings.gpu_provider_url, token=settings.gpu_provider_token
            ),
            template=ServerlessWhisperProvider("https://placeholder.invalid"),
            implemented=True,
            unmet=credential(settings.gpu_provider_url, "GPU_PROVIDER_URL"),
        ),
        _Registration(
            name="elevenlabs",
            factory=lambda: ElevenLabsScribeProvider(settings.elevenlabs_api_key),
            template=ElevenLabsScribeProvider(""),
            implemented=False,
            unmet=credential(settings.elevenlabs_api_key, "ELEVENLABS_API_KEY"),
        ),
        _Registration(
            name="sarvam",
            factory=lambda: SarvamSaarasProvider(settings.sarvam_api_key),
            template=SarvamSaarasProvider(""),
            implemented=False,
            unmet=credential(settings.sarvam_api_key, "SARVAM_API_KEY"),
        ),
        _Registration(
            name="assemblyai",
            factory=lambda: AssemblyAiProvider(settings.assemblyai_api_key),
            template=AssemblyAiProvider(""),
            implemented=False,
            unmet=credential(settings.assemblyai_api_key, "ASSEMBLYAI_API_KEY"),
        ),
    )
    return ProviderRegistry(settings, registrations)


def _faster_whisper_missing() -> str | None:
    """``local-whisper`` needs an optional dependency that may not be installed."""
    from importlib.util import find_spec

    if find_spec("faster_whisper") is None:
        return 'faster-whisper is not installed (pip install -e ".[local-asr]")'
    return None
