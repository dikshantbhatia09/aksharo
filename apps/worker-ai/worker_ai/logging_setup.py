"""One JSON object per log line, matching the Node workers' format.

A09 replaces this with the shared OpenTelemetry setup. Never log a settings value
— secrets must not reach stdout (THREAT-MODEL T21).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any

__all__ = ["JsonFormatter", "configure_logging", "get_logger"]

_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}


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


#: Third-party loggers held at WARNING, whatever ``LOG_LEVEL`` says.
#:
#: ``httpx2`` logs every request at INFO as ``HTTP Request: POST <full url>``.
#: Sarvam's Batch API hands back **Azure blob SAS URLs with the signature in the
#: query string** (`providers/sarvam.py`), so that one line would write a live
#: credential into the pod's logs on every job — exactly what THREAT-MODEL T21
#: forbids. `providers/http.py` logs the path with the query string stripped
#: instead, which is the information an operator actually needs.
_QUIET_LOGGERS: tuple[str, ...] = ("httpx2", "httpcore2", "httpx", "httpcore")


def configure_logging(service: str = "worker-ai") -> None:
    """Install the JSON formatter on the root logger, honouring ``LOG_LEVEL``."""
    level_name = os.environ.get("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str = "worker_ai") -> logging.Logger:
    """Return a namespaced logger."""
    return logging.getLogger(name)
