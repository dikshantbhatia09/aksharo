"""The GPU model server: Whisper, forced alignment and diarisation behind HTTP.

Decision **D15** puts one model server on a per-second serverless GPU with
Whisper ``large-v3-turbo``, the forced aligners and pyannote community-1
co-resident, so a transcript never crosses an instance boundary mid-file. This
package is that server. ``apps/worker-ai`` is its only client, through
``providers/serverless_whisper.py``, ``lid.py`` and ``diarisation/pyannote.py``.

The wire contract is fixed by those three clients and by the recorded fixtures in
``apps/worker-ai/worker_ai/fixtures/vendor/gpu-whisper/session.json``. Times on
the wire are **seconds** everywhere except ``/detect-language``'s ``windows``,
which the client sends in milliseconds; both are matched exactly rather than
tidied up, because the client is already written.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
