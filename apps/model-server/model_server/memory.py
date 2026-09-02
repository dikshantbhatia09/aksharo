"""The GPU memory guard: refuse before the allocator does.

A 24 GB card holding ``large-v3-turbo``, a CTC head and pyannote has roughly
18 GB of working room. Two ten-minute chunks and a whole-file diarisation
arriving together can exceed it, and the failure mode without a guard is a CUDA
out-of-memory *inside* the model call: the request dies, and often the process
with it, taking every other in-flight request down and costing a cold start.

So the guard reserves an **estimate** before the model call and refuses with
``503`` plus ``Retry-After`` when the estimate does not fit. The client
(``apps/worker-ai/worker_ai/providers/http.py``) already treats 5xx as retryable
and already obeys ``Retry-After``, so a refusal costs a wait rather than a job.

The estimate is deliberately crude — bytes per second of audio, from
``MODEL_SERVER_MEMORY_BYTES_PER_AUDIO_SECOND`` — because it only has to be
*monotonic in the thing that actually grows* and *deterministic*, and a crude
number that is always the same is worth more here than a good number that moves
with the allocator. What the guard is not modelling is visible on the dashboard:
``model_server_memory_reserved_bytes`` against ``montaj.gpu.memory.used``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from model_server.errors import OverloadedError

__all__ = ["MemoryGuard", "Reservation"]


@dataclass(frozen=True, slots=True)
class Reservation:
    """What one request holds while its model call runs."""

    bytes_held: int
    audio_seconds: float


class MemoryGuard:
    """A counting semaphore in bytes, with a deterministic refusal."""

    def __init__(
        self,
        *,
        budget_bytes: int,
        bytes_per_audio_second: int,
        retry_after_s: int = 5,
        floor_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        if budget_bytes < 1:
            raise ValueError("budget_bytes must be positive")
        self.budget_bytes = budget_bytes
        self.bytes_per_audio_second = max(1, bytes_per_audio_second)
        self.retry_after_s = max(1, retry_after_s)
        self.floor_bytes = max(0, floor_bytes)
        self._reserved = 0

    @property
    def reserved_bytes(self) -> int:
        return self._reserved

    def estimate(self, audio_seconds: float, *, factor: float = 1.0) -> int:
        """Bytes one request of this length is assumed to need.

        ``factor`` lets a route say it is heavier than transcription:
        whole-file diarisation holds an embedding matrix over the entire file, so
        it asks for more than one chunk of Whisper does.
        """
        scaled = max(0.0, audio_seconds) * self.bytes_per_audio_second * max(0.0, factor)
        return self.floor_bytes + int(scaled)

    @contextmanager
    def reserve(self, audio_seconds: float, *, factor: float = 1.0) -> Iterator[Reservation]:
        """Hold an estimate for the duration of a model call, or refuse.

        :raises OverloadedError: 503 with ``Retry-After`` when the estimate does
            not fit inside the remaining budget.
        """
        needed = self.estimate(audio_seconds, factor=factor)
        if needed > self.budget_bytes:
            # It would not fit on an empty card either: retrying cannot help, but
            # the client's only lever is a smaller chunk, so say which one it is.
            raise OverloadedError(
                "this request needs about "
                + str(needed // (1024 * 1024))
                + " MB and the whole budget is "
                + str(self.budget_bytes // (1024 * 1024))
                + " MB; send a shorter chunk",
                details={"neededBytes": needed, "budgetBytes": self.budget_bytes},
                retry_after_s=self.retry_after_s,
            )
        if self._reserved + needed > self.budget_bytes:
            raise OverloadedError(
                "the model server is at its memory budget",
                details={
                    "neededBytes": needed,
                    "reservedBytes": self._reserved,
                    "budgetBytes": self.budget_bytes,
                },
                retry_after_s=self.retry_after_s,
            )
        self._reserved += needed
        try:
            yield Reservation(bytes_held=needed, audio_seconds=audio_seconds)
        finally:
            self._reserved = max(0, self._reserved - needed)
