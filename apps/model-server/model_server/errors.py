"""The error envelope from CONTRACTS section 8, and the codes this app raises.

``{ "error": { "code", "message", "details?", "requestId" } }`` with codes in
``namespace/slug`` form. The namespace is ``model-server`` throughout.

The worker's client (``providers/http.py``) routes on the **status code**, not on
the slug: 429 and 5xx retry, other 4xx do not. So the mapping below is chosen for
what it makes the caller do, and the slug is for the human reading the log:

* ``401`` — a bad or missing bearer token. Never retried, correctly: a wrong key
  stays wrong.
* ``413`` — the body is larger than the limit. Not retryable.
* ``422`` — the body is not a valid request. Not retryable.
* ``503 + Retry-After`` — the memory guard, a draining worker, or a model that is
  not resident yet. Retryable, and the header says when.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "AudioError",
    "ModelServerError",
    "ModelUnavailableError",
    "OverloadedError",
    "PayloadTooLargeError",
    "UnauthorizedError",
    "error_body",
]


class ModelServerError(Exception):
    """Base: an HTTP status, a ``namespace/slug`` code and a safe message."""

    status_code = 500
    code = "model-server/internal"

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        retry_after_s: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}
        self.retry_after_s = retry_after_s

    @property
    def headers(self) -> dict[str, str]:
        """``Retry-After`` when this error is worth coming back from."""
        if self.retry_after_s is None:
            return {}
        return {"retry-after": str(self.retry_after_s)}


class UnauthorizedError(ModelServerError):
    """No bearer token, or one that does not match ``GPU_PROVIDER_TOKEN``."""

    status_code = 401
    code = "model-server/unauthorized"


class PayloadTooLargeError(ModelServerError):
    """The request body, or the audio inside it, is over the configured limit."""

    status_code = 413
    code = "model-server/payload-too-large"


class AudioError(ModelServerError):
    """The audio could not be fetched, decoded, or is longer than the chunk cap."""

    status_code = 422
    code = "model-server/bad-audio"


class ModelUnavailableError(ModelServerError):
    """A backend is not installed, not resident, or has no checkpoint for the language."""

    status_code = 503
    code = "model-server/model-unavailable"


class OverloadedError(ModelServerError):
    """The memory guard refused, or the worker is draining. Always carries ``Retry-After``."""

    status_code = 503
    code = "model-server/overloaded"


def error_body(error: ModelServerError, request_id: str) -> dict[str, Any]:
    """The CONTRACTS section 8 envelope for one error."""
    body: dict[str, Any] = {
        "code": error.code,
        "message": error.message,
        "requestId": request_id,
    }
    if error.details:
        body["details"] = error.details
    return {"error": body}
