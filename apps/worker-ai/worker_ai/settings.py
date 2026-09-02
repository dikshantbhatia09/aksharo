"""Environment loading for the Python AI worker.

Mirrors ``loadEnv()`` from ``@montaj/config``: the same variables from
``docs/CONTRACTS.md`` section 1, the same fail-fast behaviour, and error messages
that name every offending variable without ever echoing a value
(THREAT-MODEL T21).

Kept dependency-free on purpose so importing settings cannot pull in a web
framework; only ``python-dotenv`` is used, to find the repository's single
``.env``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

__all__ = [
    "CONTRACT_ENV_VARS",
    "DEFAULT_CACHE_MAX_ENTRY_BYTES",
    "DEFAULT_CONCURRENCY",
    "DEFAULT_CONTROL_PORT",
    "REQUIRED_ENV_VARS",
    "WORKER_ENV_VARS",
    "BucketSettings",
    "EnvValidationError",
    "Settings",
    "load_repo_dotenv",
    "load_settings",
]

#: Concurrent jobs per queue. Tuned against the serverless-GPU pool in A10.
DEFAULT_CONCURRENCY = 4

#: Control app port; pod-internal only, never exposed publicly.
#: 8091 rather than the more common 8081, which collides on many dev machines.
DEFAULT_CONTROL_PORT = 8091

#: Largest transcription result the `09 §1` cache will store, in bytes.
DEFAULT_CACHE_MAX_ENTRY_BYTES = 512 * 1024

#: Deployment naming this worker reads straight from the process environment.
#:
#: None of these are in CONTRACTS section 1, which is the frozen list of
#: *product* configuration. They follow the precedent the API set for
#: ``MONTAJ_QUEUE_PREFIX`` and the OpenTelemetry variables: infrastructure naming
#: lives with the service that reads it and is documented in its README.
WORKER_ENV_VARS: tuple[str, ...] = (
    "MONTAJ_QUEUE_PREFIX",
    "WORKER_AI_CONCURRENCY",
    "WORKER_AI_PORT",
    "WORKER_AI_QUEUES",
    "WORKER_AI_ROUTING_FILE",
    "WORKER_AI_VAD_MODEL",
    "WORKER_AI_WHISPER_MODEL",
    "WORKER_AI_ALLOW_MOCK",
    "WORKER_AI_ALIGN_MODEL_DIR",
    "WORKER_AI_INDICLID_DIR",
    "WORKER_AI_CACHE",
    "WORKER_AI_CACHE_MAX_BYTES",
    "WORKER_AI_ROUTING_OVERRIDES_FROM_API",
    "ROUTING_OVERRIDES_JSON",
    "ELEVENLABS_BASE_URL",
    "ELEVENLABS_ZERO_RETENTION",
    "SARVAM_BASE_URL",
    "ASSEMBLYAI_BASE_URL",
    "GPU_PROVIDER_URL",
    "GPU_PROVIDER_TOKEN",
    "FFMPEG_BIN",
    "FFPROBE_BIN",
)

#: Every variable in CONTRACTS section 1, in contract order.
CONTRACT_ENV_VARS: tuple[str, ...] = (
    "DATABASE_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET_RAW",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET_DERIVED",
    "R2_ACCESS_KEY",
    "R2_SECRET_KEY",
    "JWT_PRIVATE_KEY",
    "JWT_PUBLIC_KEY",
    "INTERNAL_CALLBACK_SECRET",
    "INTERNAL_CALLBACK_SECRET_NEXT",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "WEB_ORIGIN",
    "API_ORIGIN",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SARVAM_API_KEY",
    "ELEVENLABS_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "LLM_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GPU_PROVIDER",
    "SENTRY_DSN",
    "POSTHOG_KEY",
    "FEATURE_FLAGS_JSON",
)

#: Subset this worker cannot start without.
REQUIRED_ENV_VARS: tuple[str, ...] = (
    "REDIS_URL",
    "API_ORIGIN",
    "INTERNAL_CALLBACK_SECRET",
)


class EnvValidationError(RuntimeError):
    """Raised on boot when the environment is incomplete or malformed."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        plural = "" if len(problems) == 1 else "s"
        detail = "\n".join(f"  - {problem}" for problem in problems)
        super().__init__(
            f"Invalid environment: {len(problems)} problem{plural}.\n"
            f"{detail}\n\n"
            "Copy .env.example to .env and fill in the missing values.\n"
            "See docs/CONTRACTS.md section 1 for the full list."
        )


@dataclass(frozen=True, slots=True)
class BucketSettings:
    """One object store: raw uploads (S3) or derived media (R2), CONTRACTS section 6."""

    endpoint: str
    region: str
    bucket: str
    access_key: str
    secret_key: str

    @property
    def configured(self) -> bool:
        """True when every field needed to build a client is present."""
        return bool(self.endpoint and self.bucket and self.access_key and self.secret_key)


@dataclass(frozen=True, slots=True)
class Settings:
    """Validated settings for the AI worker."""

    redis_url: str
    api_origin: str
    internal_callback_secret: str
    llm_provider: str
    gpu_provider: str
    #: Optional provider credentials; empty string means "not configured".
    sarvam_api_key: str
    elevenlabs_api_key: str
    assemblyai_api_key: str
    anthropic_api_key: str
    openai_api_key: str
    sentry_dsn: str
    #: Object stores. Derived media (``audio16k.wav``) is what this worker reads.
    raw_bucket: BucketSettings
    derived_bucket: BucketSettings
    #: Deployment naming (see :data:`WORKER_ENV_VARS`).
    queue_prefix: str = "bull"
    concurrency: int = DEFAULT_CONCURRENCY
    control_port: int = DEFAULT_CONTROL_PORT
    #: Queues this process consumes; empty means "every ai.* queue".
    queues: tuple[str, ...] = ()
    routing_file: str = ""
    vad_model_path: str = ""
    whisper_model: str = "small"
    gpu_provider_url: str = ""
    gpu_provider_token: str = ""
    allow_mock: bool | None = None
    #: Vendor endpoints. The defaults are the global ones; Indian production
    #: media belongs on the residency endpoints once A00-06 signs the terms.
    elevenlabs_base_url: str = ""
    elevenlabs_zero_retention: bool = True
    sarvam_base_url: str = ""
    assemblyai_base_url: str = ""
    #: Model directories for the D13 aligners and the IndicLID classifier. Both
    #: fall back to a model-free path when unset, so CI never downloads weights.
    align_model_dir: str = ""
    indiclid_dir: str = ""
    #: ``redis`` (default when REDIS_URL is set), ``memory`` or ``none``.
    cache_backend: str = ""
    cache_max_entry_bytes: int = 0
    #: Admin routing weights: JSON in the environment, and/or fetched from the
    #: API's ``GET /internal/routing`` when that endpoint exists (B13).
    routing_overrides_json: str = ""
    routing_overrides_from_api: bool = False
    feature_flags: dict[str, Any] = field(default_factory=dict)

    @property
    def has_any_asr_provider(self) -> bool:
        """True when at least one cloud ASR credential is configured.

        A09 runs happily without one: the mock provider covers development and
        the Playwright end-to-end suite.
        """
        return any(
            (self.sarvam_api_key, self.elevenlabs_api_key, self.assemblyai_api_key),
        )

    @property
    def cache_kind(self) -> str:
        """Which result cache to build (`09 §1`): ``redis``, ``memory`` or ``none``.

        Redis is already a hard dependency of this worker — BullMQ lives there —
        so the default is ``redis`` whenever a URL is configured, and the explicit
        setting exists for a test or a pod that must not share the cache.
        """
        explicit = self.cache_backend.strip().lower()
        if explicit in {"redis", "memory", "none"}:
            return explicit
        return "redis" if self.redis_url else "none"

    @property
    def mock_allowed(self) -> bool:
        """Whether routing may fall back to the deterministic mock provider.

        Explicit ``WORKER_AI_ALLOW_MOCK`` wins; otherwise the mock is allowed
        exactly when no cloud ASR credential and no GPU endpoint is configured,
        which is the state of every developer machine and of CI.
        """
        if self.allow_mock is not None:
            return self.allow_mock
        return not self.has_any_asr_provider and not self.gpu_provider_url

    def flag(self, name: str, default: bool = True) -> bool:
        """Read a boolean feature flag from ``FEATURE_FLAGS_JSON``.

        Unknown flags take ``default`` so a provider is never silently disabled
        by a flag nobody has written yet.
        """
        value = self.feature_flags.get(name, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)


def load_repo_dotenv(start: Path | None = None) -> Path | None:
    """Load the nearest ``.env`` walking up to the filesystem root.

    Real environment variables always win, so a container or CI runner overrides
    the file without editing it.

    Returns the path that was loaded, or ``None`` when no ``.env`` exists.
    """
    current = (start or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        candidate = directory / ".env"
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return candidate
    return None


_VALID_LLM_PROVIDERS = frozenset({"anthropic", "openai", "mock"})
_VALID_GPU_PROVIDERS = frozenset({"runpod", "modal", "replicate", "none"})


def load_settings(source: dict[str, str] | None = None) -> Settings:
    """Validate the environment or raise :class:`EnvValidationError`.

    :param source: values to read instead of ``os.environ`` (used by tests).
    """
    env: dict[str, str] = dict(os.environ) if source is None else dict(source)
    problems: list[str] = []

    def required(name: str) -> str:
        value = env.get(name, "").strip()
        if not value:
            problems.append(f"{name} is missing" if name not in env else f"{name} is empty")
        return value

    redis_url = required("REDIS_URL")
    if redis_url and not redis_url.startswith(("redis://", "rediss://")):
        problems.append("REDIS_URL: must be a redis:// or rediss:// connection string")

    api_origin = required("API_ORIGIN")
    if api_origin and not api_origin.startswith(("http://", "https://")):
        problems.append("API_ORIGIN: must be an http(s) URL, for example http://localhost:3001")

    callback_secret = required("INTERNAL_CALLBACK_SECRET")
    if callback_secret and len(callback_secret) < 32:
        problems.append(
            "INTERNAL_CALLBACK_SECRET: must be at least 32 characters "
            "(32 random bytes, hex-encoded)"
        )

    llm_provider = env.get("LLM_PROVIDER", "mock").strip() or "mock"
    if llm_provider not in _VALID_LLM_PROVIDERS:
        problems.append(f"LLM_PROVIDER: must be one of {', '.join(sorted(_VALID_LLM_PROVIDERS))}")

    gpu_provider = env.get("GPU_PROVIDER", "none").strip() or "none"
    if gpu_provider not in _VALID_GPU_PROVIDERS:
        problems.append(f"GPU_PROVIDER: must be one of {', '.join(sorted(_VALID_GPU_PROVIDERS))}")

    gpu_provider_url = env.get("GPU_PROVIDER_URL", "").strip()
    if gpu_provider_url and not gpu_provider_url.startswith(("http://", "https://")):
        problems.append("GPU_PROVIDER_URL: must be an http(s) URL")

    flags_raw = env.get("FEATURE_FLAGS_JSON", "").strip()
    feature_flags: dict[str, Any] = {}
    if flags_raw:
        try:
            parsed = json.loads(flags_raw)
        except ValueError:
            problems.append("FEATURE_FLAGS_JSON: must be a JSON object")
        else:
            if isinstance(parsed, dict):
                feature_flags = {str(key): value for key, value in parsed.items()}
            else:
                problems.append("FEATURE_FLAGS_JSON: must be a JSON object")

    concurrency = _positive_int(env, "WORKER_AI_CONCURRENCY", DEFAULT_CONCURRENCY, problems)
    control_port = _positive_int(env, "WORKER_AI_PORT", DEFAULT_CONTROL_PORT, problems)
    cache_max_bytes = _positive_int(
        env, "WORKER_AI_CACHE_MAX_BYTES", DEFAULT_CACHE_MAX_ENTRY_BYTES, problems
    )

    cache_backend = env.get("WORKER_AI_CACHE", "").strip().lower()
    if cache_backend and cache_backend not in {"redis", "memory", "none"}:
        problems.append("WORKER_AI_CACHE: must be one of redis, memory, none")

    for variable in ("ELEVENLABS_BASE_URL", "SARVAM_BASE_URL", "ASSEMBLYAI_BASE_URL"):
        value = env.get(variable, "").strip()
        if value and not value.startswith(("http://", "https://")):
            problems.append(variable + ": must be an http(s) URL")

    if problems:
        raise EnvValidationError(sorted(set(problems)))

    return Settings(
        redis_url=redis_url,
        api_origin=api_origin.rstrip("/"),
        internal_callback_secret=callback_secret,
        llm_provider=llm_provider,
        gpu_provider=gpu_provider,
        sarvam_api_key=env.get("SARVAM_API_KEY", "").strip(),
        elevenlabs_api_key=env.get("ELEVENLABS_API_KEY", "").strip(),
        assemblyai_api_key=env.get("ASSEMBLYAI_API_KEY", "").strip(),
        anthropic_api_key=env.get("ANTHROPIC_API_KEY", "").strip(),
        openai_api_key=env.get("OPENAI_API_KEY", "").strip(),
        sentry_dsn=env.get("SENTRY_DSN", "").strip(),
        raw_bucket=BucketSettings(
            endpoint=env.get("S3_ENDPOINT", "").strip(),
            region=env.get("S3_REGION", "auto").strip() or "auto",
            bucket=env.get("S3_BUCKET_RAW", "").strip(),
            access_key=env.get("S3_ACCESS_KEY", "").strip(),
            secret_key=env.get("S3_SECRET_KEY", "").strip(),
        ),
        derived_bucket=BucketSettings(
            endpoint=env.get("R2_ENDPOINT", "").strip(),
            # R2 has one region; MinIO in compose ignores it. `auto` is what the
            # Cloudflare SDK documents and what the Node side sends.
            region=env.get("R2_REGION", "auto").strip() or "auto",
            bucket=env.get("R2_BUCKET_DERIVED", "").strip(),
            access_key=env.get("R2_ACCESS_KEY", "").strip(),
            secret_key=env.get("R2_SECRET_KEY", "").strip(),
        ),
        queue_prefix=env.get("MONTAJ_QUEUE_PREFIX", "").strip() or "bull",
        concurrency=concurrency,
        control_port=control_port,
        queues=tuple(
            name.strip() for name in env.get("WORKER_AI_QUEUES", "").split(",") if name.strip()
        ),
        routing_file=env.get("WORKER_AI_ROUTING_FILE", "").strip(),
        vad_model_path=env.get("WORKER_AI_VAD_MODEL", "").strip(),
        whisper_model=env.get("WORKER_AI_WHISPER_MODEL", "").strip() or "small",
        gpu_provider_url=gpu_provider_url.rstrip("/"),
        gpu_provider_token=env.get("GPU_PROVIDER_TOKEN", "").strip(),
        allow_mock=_optional_bool(env.get("WORKER_AI_ALLOW_MOCK")),
        elevenlabs_base_url=env.get("ELEVENLABS_BASE_URL", "").strip().rstrip("/"),
        elevenlabs_zero_retention=_optional_bool(env.get("ELEVENLABS_ZERO_RETENTION")) is not False,
        sarvam_base_url=env.get("SARVAM_BASE_URL", "").strip().rstrip("/"),
        assemblyai_base_url=env.get("ASSEMBLYAI_BASE_URL", "").strip().rstrip("/"),
        align_model_dir=env.get("WORKER_AI_ALIGN_MODEL_DIR", "").strip(),
        indiclid_dir=env.get("WORKER_AI_INDICLID_DIR", "").strip(),
        cache_backend=env.get("WORKER_AI_CACHE", "").strip(),
        cache_max_entry_bytes=cache_max_bytes,
        routing_overrides_json=env.get("ROUTING_OVERRIDES_JSON", "").strip(),
        routing_overrides_from_api=(
            _optional_bool(env.get("WORKER_AI_ROUTING_OVERRIDES_FROM_API")) is True
        ),
        feature_flags=feature_flags,
    )


def _positive_int(env: dict[str, str], name: str, default: int, problems: list[str]) -> int:
    """Parse a positive integer, recording a problem rather than raising."""
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        problems.append(f"{name}: must be a positive integer")
        return default
    if value <= 0:
        problems.append(f"{name}: must be a positive integer")
        return default
    return value


def _optional_bool(raw: str | None) -> bool | None:
    """Tri-state: unset stays ``None`` so the caller can pick its own default."""
    if raw is None or not raw.strip():
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}
