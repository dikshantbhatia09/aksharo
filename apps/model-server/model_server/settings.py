"""Configuration, read once from the environment and then frozen.

Two rules run through this file:

* **The bearer token is the only secret**, it is ``GPU_PROVIDER_TOKEN`` from
  CONTRACTS section 1, and it is never logged, never echoed and never put in an
  error message (THREAT-MODEL T21). :meth:`Settings.redacted` is what a log line
  gets.
* **An unauthenticated model server is a refusal, not a warning.** A container
  that starts with no token and serves anyway is a GPU somebody else can spend,
  so the app refuses to boot unless ``MODEL_SERVER_ALLOW_ANONYMOUS=1`` says a
  human meant it (local development, and the CPU smoke in CI).

Everything else is ``MODEL_SERVER_*``. ``COMPUTE_TYPE`` is honoured as a fallback
for ``MODEL_SERVER_COMPUTE_TYPE`` because X05's ``infra/gpu/runpod/endpoint.json``
already sets it in the endpoint template.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "DEFAULT_DIARISER_MODEL",
    "DEFAULT_WHISPER_MODEL",
    "ConfigurationError",
    "Settings",
]

#: Decision D15 names this checkpoint; `09 §2` and the routing table agree.
DEFAULT_WHISPER_MODEL = "large-v3-turbo"

#: Decision D13/D77: community-1, CC-BY-4.0, attribution surfaced in the response.
DEFAULT_DIARISER_MODEL = "pyannote/speaker-diarization-community-1"

_TRUE = frozenset({"1", "true", "yes", "on"})


class ConfigurationError(RuntimeError):
    """The environment cannot produce a servable configuration."""


def _text(env: Mapping[str, str], name: str, default: str = "") -> str:
    return env.get(name, default).strip()


def _flag(env: Mapping[str, str], name: str, default: bool = False) -> bool:
    raw = _text(env, name)
    if not raw:
        return default
    return raw.casefold() in _TRUE


def _number(env: Mapping[str, str], name: str, default: int, *, minimum: int = 0) -> int:
    raw = _text(env, name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigurationError(name + " must be an integer, got " + raw) from error
    if value < minimum:
        raise ConfigurationError(name + " must be at least " + str(minimum))
    return value


def _decimal(env: Mapping[str, str], name: str, default: float, *, minimum: float = 0.0) -> float:
    raw = _text(env, name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ConfigurationError(name + " must be a number, got " + raw) from error
    if value < minimum:
        raise ConfigurationError(name + " must be at least " + str(minimum))
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    """Everything the app reads from the environment."""

    # -- identity and transport --------------------------------------------
    host: str = "0.0.0.0"  # noqa: S104 - a container listens on every interface
    port: int = 8000
    token: str = ""
    allow_anonymous: bool = False
    log_level: str = "info"

    # -- device and models --------------------------------------------------
    device: str = "cuda"
    compute_type: str = ""
    whisper_model: str = DEFAULT_WHISPER_MODEL
    diariser_model: str = DEFAULT_DIARISER_MODEL
    align_model_dir: str = ""
    model_cache_dir: str = ""
    #: Which backends must be resident before ``/readyz`` says yes.
    preload: tuple[str, ...] = ("asr",)

    # -- limits -------------------------------------------------------------
    max_body_bytes: int = 64 * 1024 * 1024
    #: `09 §1` cuts chunks at ~10 minutes; anything longer is a caller bug.
    max_audio_seconds: float = 600.0
    request_timeout_s: float = 1800.0

    # -- batching -----------------------------------------------------------
    batch_max_size: int = 8
    batch_window_ms: int = 50

    # -- memory guard -------------------------------------------------------
    memory_budget_bytes: int = 18 * 1024 * 1024 * 1024
    memory_bytes_per_audio_second: int = 3 * 1024 * 1024
    memory_retry_after_s: int = 5

    # -- lifecycle ----------------------------------------------------------
    drain_timeout_s: float = 30.0

    # -- runpod -------------------------------------------------------------
    runpod_require_token: bool = False

    #: Free-form, for the log line that says how this process was configured.
    extra: dict[str, str] = field(default_factory=dict)

    # -- derived ------------------------------------------------------------

    @property
    def on_gpu(self) -> bool:
        return self.device != "cpu"

    @property
    def effective_compute_type(self) -> str:
        """``float16`` on a card, ``int8`` on a laptop, unless told otherwise."""
        if self.compute_type:
            return self.compute_type
        return "float16" if self.on_gpu else "int8"

    @property
    def batch_window_s(self) -> float:
        return self.batch_window_ms / 1000.0

    def redacted(self) -> dict[str, Any]:
        """A log-safe view: every field except the token, which never appears."""
        return {
            "device": self.device,
            "computeType": self.effective_compute_type,
            "whisperModel": self.whisper_model,
            "diariserModel": self.diariser_model,
            "alignModelDir": self.align_model_dir or None,
            "preload": list(self.preload),
            "batchMaxSize": self.batch_max_size,
            "batchWindowMs": self.batch_window_ms,
            "maxAudioSeconds": self.max_audio_seconds,
            "maxBodyBytes": self.max_body_bytes,
            "memoryBudgetBytes": self.memory_budget_bytes,
            "authenticated": bool(self.token),
        }

    # -- construction -------------------------------------------------------

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Read the environment, validate it, and refuse anything unservable."""
        source: Mapping[str, str] = os.environ if env is None else env

        device = _text(source, "MODEL_SERVER_DEVICE", "cuda").casefold() or "cuda"
        if device not in {"cuda", "cpu"}:
            raise ConfigurationError("MODEL_SERVER_DEVICE must be 'cuda' or 'cpu', got " + device)

        token = _text(source, "GPU_PROVIDER_TOKEN")
        allow_anonymous = _flag(source, "MODEL_SERVER_ALLOW_ANONYMOUS")
        if not token and not allow_anonymous:
            raise ConfigurationError(
                "GPU_PROVIDER_TOKEN is empty. An unauthenticated model server is a GPU "
                "anyone can spend; set the token, or set MODEL_SERVER_ALLOW_ANONYMOUS=1 "
                "to say the exposure is intended (local development only)."
            )

        preload_raw = _text(source, "MODEL_SERVER_PRELOAD", "asr")
        preload = tuple(part.strip().casefold() for part in preload_raw.split(",") if part.strip())
        unknown = set(preload) - {"asr", "align", "diarise"}
        if unknown:
            raise ConfigurationError(
                "MODEL_SERVER_PRELOAD accepts asr, align and diarise; got "
                + ", ".join(sorted(unknown))
            )

        # A 24 GB card with three models resident has roughly 18 GB of working
        # room; a CPU box is bounded by host RAM, so the default drops.
        default_budget_mb = 18 * 1024 if device == "cuda" else 4 * 1024

        return cls(
            host=_text(source, "MODEL_SERVER_HOST", "0.0.0.0"),  # noqa: S104
            port=_number(source, "MODEL_SERVER_PORT", 8000, minimum=1),
            token=token,
            allow_anonymous=allow_anonymous,
            log_level=_text(source, "LOG_LEVEL", "info").casefold() or "info",
            device=device,
            compute_type=_text(source, "MODEL_SERVER_COMPUTE_TYPE")
            or _text(source, "COMPUTE_TYPE"),
            whisper_model=_text(source, "MODEL_SERVER_WHISPER_MODEL", DEFAULT_WHISPER_MODEL),
            diariser_model=_text(source, "MODEL_SERVER_DIARISER_MODEL", DEFAULT_DIARISER_MODEL),
            align_model_dir=_text(source, "MODEL_SERVER_ALIGN_MODEL_DIR"),
            model_cache_dir=_text(source, "MODEL_SERVER_MODEL_CACHE") or _text(source, "HF_HOME"),
            preload=preload,
            max_body_bytes=_number(source, "MODEL_SERVER_MAX_BODY_MB", 64, minimum=1) * 1024 * 1024,
            max_audio_seconds=_decimal(
                source, "MODEL_SERVER_MAX_AUDIO_SECONDS", 600.0, minimum=1.0
            ),
            request_timeout_s=_decimal(
                source, "MODEL_SERVER_REQUEST_TIMEOUT_S", 1800.0, minimum=1.0
            ),
            batch_max_size=_number(source, "MODEL_SERVER_BATCH_MAX_SIZE", 8, minimum=1),
            batch_window_ms=_number(source, "MODEL_SERVER_BATCH_WINDOW_MS", 50, minimum=0),
            memory_budget_bytes=_number(
                source, "MODEL_SERVER_MEMORY_BUDGET_MB", default_budget_mb, minimum=1
            )
            * 1024
            * 1024,
            memory_bytes_per_audio_second=_number(
                source, "MODEL_SERVER_MEMORY_BYTES_PER_AUDIO_SECOND", 3 * 1024 * 1024, minimum=1
            ),
            memory_retry_after_s=_number(source, "MODEL_SERVER_MEMORY_RETRY_AFTER_S", 5, minimum=1),
            drain_timeout_s=_decimal(source, "MODEL_SERVER_DRAIN_TIMEOUT_S", 30.0, minimum=0.0),
            runpod_require_token=_flag(source, "MODEL_SERVER_RUNPOD_REQUIRE_TOKEN"),
        )
