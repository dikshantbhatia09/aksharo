"""One JSON object per log line, the same shape ``apps/worker-ai`` emits.

Two things must never reach stdout from this process:

* **a credential** — the bearer token, an HF token, a presigned URL's query
  string (THREAT-MODEL T21); and
* **audio** — not the bytes, not a base64 payload, not a transcript. A GPU worker
  holds user media for the length of one request and writes none of it anywhere,
  which is the ``retentionClass: ephemeral`` the worker records against every
  submission. A log line with a transcript in it silently breaks that promise.

:func:`safe_extra` is the chokepoint: route handlers build their log fields
through it, and it drops anything whose key looks like a payload or a secret.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any
from urllib.parse import urlsplit

__all__ = ["JsonFormatter", "configure_logging", "get_logger", "safe_extra", "safe_uri"]

_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}

#: Keys that carry media, text or a credential. Dropped, never truncated: a
#: truncated token is still a token prefix, and a truncated transcript is still
#: user speech.
_FORBIDDEN = frozenset(
    {
        "audio",
        "attribution",
        "authorization",
        "body",
        "hints",
        "initialprompt",
        "payload",
        "samples",
        "secret",
        "segments",
        "text",
        "textsignal",
        "token",
        "transcript",
        "turns",
        "words",
    }
)

#: httpx logs every request at INFO with the full URL. A presigned URL carries
#: its signature in the query string, so that line would write a live credential
#: into the pod's logs.
_QUIET_LOGGERS: tuple[str, ...] = ("httpx2", "httpcore2", "httpx", "httpcore", "urllib3")


class JsonFormatter(logging.Formatter):
    """Render a record as a single JSON line, keeping any extra fields."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "service": self.service,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(service: str = "model-server", level_name: str = "info") -> None:
    """Install the JSON formatter on the root logger."""
    level = getattr(logging, level_name.upper(), logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str = "model_server") -> logging.Logger:
    """Return a namespaced logger."""
    return logging.getLogger(name)


def safe_extra(fields: dict[str, Any]) -> dict[str, Any]:
    """Drop anything that could be media, transcript text or a credential."""
    return {key: value for key, value in fields.items() if key.casefold() not in _FORBIDDEN}


def safe_uri(uri: str) -> str:
    """A URI reduced to what an operator needs: scheme, host and path.

    A base64 payload becomes ``inline:<n> bytes`` and a presigned URL loses its
    signature, so the audio the caller sent can be talked about in a log line
    without any of it being in the log line.
    """
    if not uri:
        return "(none)"
    lowered = uri[:32].casefold()
    if lowered.startswith(("data:", "base64:")) or "://" not in uri:
        if lowered.startswith(("data:", "base64:")):
            return "inline:" + str(len(uri)) + " chars"
        return "path:" + str(len(uri)) + " chars"
    parts = urlsplit(uri)
    return parts.scheme + "://" + parts.netloc + parts.path
