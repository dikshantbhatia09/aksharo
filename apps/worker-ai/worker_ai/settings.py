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

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

__all__ = [
    "CONTRACT_ENV_VARS",
    "REQUIRED_ENV_VARS",
    "EnvValidationError",
    "Settings",
    "load_repo_dotenv",
    "load_settings",
]

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

    @property
    def has_any_asr_provider(self) -> bool:
        """True when at least one cloud ASR credential is configured.

        A09 runs happily without one: the mock provider covers development and
        the Playwright end-to-end suite.
        """
        return any(
            (self.sarvam_api_key, self.elevenlabs_api_key, self.assemblyai_api_key),
        )


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

    if problems:
        raise EnvValidationError(sorted(set(problems)))

    return Settings(
        redis_url=redis_url,
        api_origin=api_origin,
        internal_callback_secret=callback_secret,
        llm_provider=llm_provider,
        gpu_provider=gpu_provider,
        sarvam_api_key=env.get("SARVAM_API_KEY", "").strip(),
        elevenlabs_api_key=env.get("ELEVENLABS_API_KEY", "").strip(),
        assemblyai_api_key=env.get("ASSEMBLYAI_API_KEY", "").strip(),
        anthropic_api_key=env.get("ANTHROPIC_API_KEY", "").strip(),
        openai_api_key=env.get("OPENAI_API_KEY", "").strip(),
        sentry_dsn=env.get("SENTRY_DSN", "").strip(),
    )
