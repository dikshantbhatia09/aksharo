"""Flash/Pro engine tiers for prompted edits (D07 SS2, 09-ai-pipeline SS6).

Python mirror of ``packages/config/src/engines.ts``'s ``ENGINE_PRESETS`` — the
same split ``worker_ai/translate/glossary.py`` and the rest of this worker
follow for a TS-owned contract that a Python processor also needs to read: the
TS module is authoritative (``@montaj/config`` is imported by
``apps/api/src/passes/passes.service.ts`` and every other TS producer), this
module is the same table typed for the processors in this package
(``worker_ai/processors/autocut_pass.py``, ``reframe_zoom_pass.py``,
``transcribe.py``'s re-pass path) that read an engine tier out of a job's
``params`` and need to know what it means without round-tripping through
Node.

::

    Flash = fast models (VAD-only cut, 540p tracking, cached picks)
    Pro   = full pipeline (LLM re-ranked cuts, full-res tracking, larger ASR re-pass)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

EngineTier = Literal["flash", "pro"]
AutocutStrategy = Literal["vad_only", "llm_reranked"]
TrackingResolution = Literal["540p", "full_res"]


@dataclass(frozen=True)
class AutocutEngineParams:
    strategy: AutocutStrategy
    cached_picks: bool


@dataclass(frozen=True)
class TrackingEngineParams:
    resolution: TrackingResolution


@dataclass(frozen=True)
class AsrEngineParams:
    # None on Flash: no re-pass, the original transcription stands.
    repass_model: str | None


@dataclass(frozen=True)
class EnginePassParams:
    tier: EngineTier
    autocut: AutocutEngineParams
    tracking: TrackingEngineParams
    asr: AsrEngineParams


ENGINE_PRESETS: dict[EngineTier, EnginePassParams] = {
    "flash": EnginePassParams(
        tier="flash",
        autocut=AutocutEngineParams(strategy="vad_only", cached_picks=True),
        tracking=TrackingEngineParams(resolution="540p"),
        asr=AsrEngineParams(repass_model=None),
    ),
    "pro": EnginePassParams(
        tier="pro",
        autocut=AutocutEngineParams(strategy="llm_reranked", cached_picks=False),
        tracking=TrackingEngineParams(resolution="full_res"),
        asr=AsrEngineParams(repass_model="asr-repass-large"),
    ),
}


def engine_params_for(tier: EngineTier | None) -> EnginePassParams:
    """``ENGINE_PRESETS[tier]``, defaulting a missing/unknown tier to ``"flash"``."""

    return ENGINE_PRESETS.get(tier or "flash", ENGINE_PRESETS["flash"])
