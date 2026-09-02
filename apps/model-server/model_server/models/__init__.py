"""Model backends: Whisper, the CTC aligners and pyannote, behind three ABCs.

Nothing heavyweight is imported at package import time. ``registry`` builds the
concrete backends and each one imports its own dependency inside :meth:`load`, so
``import model_server`` costs nothing on a machine with no CUDA stack.
"""

from __future__ import annotations

__all__: list[str] = []
