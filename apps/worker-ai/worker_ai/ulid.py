"""A minimal ULID generator (CONTRACTS section 0: every id is a ULID).

Needed because `ai.translate` mints `EdgOp.opId` client-side before submitting a
`SetSegmentText` batch to `POST /internal/projects/{id}/edg/ops`
(`processors/translate.py`) — the same requirement `newId()` in
`packages/edg/src/ids.ts` meets on the TypeScript side. No third-party ULID
package is a dependency of this worker, and the algorithm is 20 lines, so it is
written once here rather than adding a dependency for it.

48-bit millisecond timestamp + 80 bits of randomness, Crockford base32 encoded,
26 characters — exactly what `ULID_PATTERN` in `packages/edg/src/ids.ts`
validates (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`).
"""

from __future__ import annotations

import os
import time

__all__ = ["new_ulid"]

_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_ulid(*, now_ms: int | None = None, randomness: bytes | None = None) -> str:
    """A new ULID. `now_ms`/`randomness` are injectable for deterministic tests."""
    timestamp_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    random_bytes = randomness if randomness is not None else os.urandom(10)
    if len(random_bytes) != 10:
        raise ValueError("ULID randomness must be exactly 10 bytes (80 bits)")

    value = (timestamp_ms & ((1 << 48) - 1)) << 80
    value |= int.from_bytes(random_bytes, "big")

    characters = ["0"] * 26
    for index in range(25, -1, -1):
        characters[index] = _CROCKFORD_ALPHABET[value & 0x1F]
        value >>= 5
    return "".join(characters)
