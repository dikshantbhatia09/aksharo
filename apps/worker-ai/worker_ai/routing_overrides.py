"""The worker's client for the admin console's routing-weight overrides.

`GET {API_ORIGIN}/internal/routing/overrides` (B13b, following on from B13's
``AdminRoutingController`` and the ``fetch_routing_overrides`` stub this
module replaces the body of): signed the same way as every other
``/internal/**`` call (``callbacks.py``'s ``sign_request``), never a JWT — a
worker has no user.

Two things this module is responsible for that the original stub was not:

* **A 60-second in-process cache, revalidated with the response's `ETag`.**
  Routing decisions happen per job, often many times a second; without a
  cache, every one of those would be a synchronous network round trip to the
  API before a chunk could even be dispatched. Within the 60-second window the
  cached body is returned with no network call at all; once it is stale, the
  next call sends `If-None-Match` and a `304` just refreshes the window
  without re-parsing anything.
* **Losing this endpoint (a network error, a bad signature, a 5xx) must not
  invalidate the last-known-good overrides.** A tuning knob going stale is
  the same failure mode as it not existing at all — see
  ``fetch_routing_overrides``'s own docstring, kept verbatim from B13's
  stub — so a fetch failure returns the last successfully cached body rather
  than `{}`, and only falls back to `{}` when nothing has ever been fetched.

**Coordination note for D08 (routing shadow/freeze, running in parallel):**
this module intentionally does not know what "frozen" means — it only
reads ``getattr(settings, "routing_freeze", False)`` (a name D08 has not
landed yet at the time this module was written) so that a frozen deployment
skips the fetch and this WP's change stays a no-op on that axis until D08's
flag exists. See this WP's final report, "open questions", for the exact
attribute name to confirm once D08 merges.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx2

from worker_ai.logging_setup import get_logger

if TYPE_CHECKING:
    from worker_ai.settings import Settings

__all__ = ["fetch_overrides", "reset_cache_for_tests"]

_log = get_logger(__name__)

OVERRIDES_PATH = "/internal/routing/overrides"
_CACHE_TTL_S = 60.0


@dataclass
class _CacheEntry:
    body: dict[str, Any]
    etag: str | None
    fetched_at: float


#: Keyed by API origin, so a test or a multi-tenant process never mixes two
#: deployments' overrides.
_cache: dict[str, _CacheEntry] = {}


def reset_cache_for_tests() -> None:
    """Clears the module-level cache. Test-only — production never needs this."""
    _cache.clear()


def fetch_overrides(settings: Settings) -> dict[str, Any]:
    """The current routing overrides, cached for 60s and revalidated by ETag.

    Returns ``{}`` when nothing has ever been fetched successfully. Never
    raises: every failure (network, 404, 5xx, a malformed body) logs once and
    falls back to the last cached body, because a tuning knob must not be
    allowed to turn an admin-console outage into an ASR outage.
    """
    if getattr(settings, "routing_freeze", False):
        _log.info("routing is frozen; skipping the overrides fetch")
        return {}

    origin = settings.api_origin
    entry = _cache.get(origin)
    now = time.monotonic()
    if entry is not None and (now - entry.fetched_at) < _CACHE_TTL_S:
        return entry.body

    timestamp = str(int(time.time()))
    signature = hmac.new(
        settings.internal_callback_secret.encode("utf-8"),
        (timestamp + ".").encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers = {"x-montaj-timestamp": timestamp, "x-montaj-signature": signature}
    if entry is not None and entry.etag is not None:
        headers["if-none-match"] = entry.etag

    try:
        response = httpx2.get(origin + OVERRIDES_PATH, headers=headers, timeout=5.0)
    except httpx2.HTTPError as error:
        _log.warning("routing overrides unavailable", extra={"reason": type(error).__name__})
        return entry.body if entry is not None else {}

    if response.status_code == 304 and entry is not None:
        _cache[origin] = _CacheEntry(body=entry.body, etag=entry.etag, fetched_at=now)
        return entry.body

    if response.status_code == 404:
        _log.info("the API exposes no /internal/routing/overrides yet; using routing.yaml as written")
        return entry.body if entry is not None else {}

    if response.status_code >= 400:
        _log.warning("routing overrides refused", extra={"status": response.status_code})
        return entry.body if entry is not None else {}

    try:
        parsed: Any = response.json()
    except ValueError:
        return entry.body if entry is not None else {}
    if not isinstance(parsed, dict):
        return entry.body if entry is not None else {}

    _cache[origin] = _CacheEntry(
        body=parsed,
        etag=response.headers.get("etag"),
        fetched_at=now,
    )
    return parsed
